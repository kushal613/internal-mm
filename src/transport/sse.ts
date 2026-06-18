import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { PATHS } from "../constants.js";
import { createLogger } from "../logger.js";
import type { QuoteRequestEvent } from "../types.js";

const log = createLogger("sse");

/**
 * Channel 1: SSE quote-request stream (server -> maker).
 *
 * Implemented as a raw fetch-stream reader (not the `eventsource` library) for two
 * reasons that previously caused us to silently fall off the maker set:
 *
 *  1. Heartbeat visibility — the server sends `: ping` comment lines every ~25s.
 *     The `eventsource` library swallows comments, so on a quiet stream we got no
 *     callbacks and could not distinguish "idle but alive" from "dead". Reading the
 *     raw byte stream lets us see pings and run a liveness watchdog.
 *
 *  2. Dead-connection detection — a half-open/zombie connection (e.g. a proxy idle
 *     timeout that drops the socket without a clean close) would leave the library
 *     believing it was still connected forever. The watchdog below force-aborts and
 *     reconnects when no bytes arrive within IDLE_TIMEOUT_MS.
 *
 * Auth: X-API-Key header. Resume: Last-Event-ID on reconnect.
 */

const IDLE_TIMEOUT_MS = 40_000; // pings arrive ~every 25s; allow one miss
const WATCHDOG_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;

export interface QuoteRequestStreamEvents {
  connected: (data: { makerId: string; serverTime: string }) => void;
  snapshot_begin: () => void;
  snapshot_complete: () => void;
  quote_request: (req: QuoteRequestEvent, eventId: string | null) => void;
  quote_request_expired: (requestId: string) => void;
  error: (err: unknown) => void;
}

interface ParsedEvent {
  event: string;
  data: string;
  id: string | null;
}

export class QuoteRequestStream extends EventEmitter {
  private controller: AbortController | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private lastActivity = 0;
  private lastEventId: string | null = null;
  private backoffMs = 1_000;
  private closed = false;
  private running = false;

  constructor(
    private readonly apiKey: string,
    private readonly base: string = config.apiBase,
  ) {
    super();
  }

  override on<E extends keyof QuoteRequestStreamEvents>(
    event: E,
    listener: QuoteRequestStreamEvents[E],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<E extends keyof QuoteRequestStreamEvents>(
    event: E,
    ...args: Parameters<QuoteRequestStreamEvents[E]>
  ): boolean {
    return super.emit(event, ...args);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.closed = false;
    void this.runLoop();
  }

  close(): void {
    this.closed = true;
    this.running = false;
    this.stopWatchdog();
    this.controller?.abort();
    this.controller = undefined;
    log.info("stream closed");
  }

  /** Reconnect loop with backoff. Each iteration holds one streaming connection. */
  private async runLoop(): Promise<void> {
    while (!this.closed) {
      try {
        await this.connectOnce();
        // Clean end of stream (server closed) — reconnect promptly.
        if (!this.closed) log.warn("stream ended; reconnecting", { delayMs: 0 });
        this.backoffMs = 1_000;
      } catch (err) {
        if (this.closed) break;
        const aborted = (err as Error)?.name === "AbortError";
        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
        log.warn(aborted ? "stream stalled; reconnecting" : "stream error; reconnecting", {
          delayMs: delay,
          err: aborted ? undefined : String(err),
        });
        this.emit("error", err);
        await sleep(delay);
      }
    }
  }

  private async connectOnce(): Promise<void> {
    const url = `${this.base.replace(/\/$/, "")}${PATHS.quoteRequestStream}`;
    const controller = new AbortController();
    this.controller = controller;

    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    };
    if (this.lastEventId) headers["Last-Event-ID"] = this.lastEventId;

    log.info("connecting", { url, resumeFrom: this.lastEventId ?? undefined });
    const res = await fetch(url, { headers, signal: controller.signal });

    if (res.status === 401 || res.status === 403) {
      this.closed = true;
      this.running = false;
      log.error("SSE auth failed — check CONVALLAX_API_KEY; not reconnecting", {
        status: res.status,
      });
      this.emit("error", new Error(`SSE auth failed (${res.status})`));
      return;
    }
    if (!res.ok || !res.body) {
      throw new Error(`SSE connect failed (${res.status})`);
    }

    this.markActivity();
    this.startWatchdog();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return; // server closed the stream
        this.markActivity();
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let sep: number;
        while ((sep = indexOfFrameEnd(buffer)) !== -1) {
          const rawFrame = buffer.slice(0, sep);
          buffer = buffer.slice(sep).replace(/^(\r\n\r\n|\n\n|\r\r)/, "");
          this.handleFrame(rawFrame);
        }
      }
    } finally {
      this.stopWatchdog();
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  private handleFrame(rawFrame: string): void {
    const parsed = parseFrame(rawFrame);
    if (!parsed) return; // comment-only frame (e.g. `: ping`) — liveness already noted
    if (parsed.id) this.lastEventId = parsed.id;

    try {
      switch (parsed.event) {
        case "connected": {
          const data = JSON.parse(parsed.data || "{}");
          log.info("stream connected", { makerId: data.makerId, serverTime: data.serverTime });
          this.emit("connected", data);
          break;
        }
        case "snapshot_begin":
          log.debug("snapshot begin");
          this.emit("snapshot_begin");
          break;
        case "snapshot_complete":
          log.debug("snapshot complete");
          this.emit("snapshot_complete");
          break;
        case "quote_request": {
          const req = JSON.parse(parsed.data) as QuoteRequestEvent;
          this.emit("quote_request", req, parsed.id);
          break;
        }
        case "quote_request_expired": {
          const { requestId } = JSON.parse(parsed.data) as { requestId: string };
          this.emit("quote_request_expired", requestId);
          break;
        }
        default:
          log.debug("unhandled SSE event", { event: parsed.event });
      }
    } catch (err) {
      log.error("failed to handle SSE frame", { event: parsed.event, err: String(err) });
      this.emit("error", err);
    }
  }

  private markActivity(): void {
    this.lastActivity = Date.now();
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      const idle = Date.now() - this.lastActivity;
      if (idle > IDLE_TIMEOUT_MS) {
        log.warn("no data within idle timeout — aborting to force reconnect", { idleMs: idle });
        this.controller?.abort();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }
}

/** Index just past the first frame separator (blank line), or -1 if none yet. */
function indexOfFrameEnd(buf: string): number {
  const candidates = [buf.indexOf("\n\n"), buf.indexOf("\r\n\r\n"), buf.indexOf("\r\r")].filter(
    (i) => i !== -1,
  );
  return candidates.length ? Math.min(...candidates) : -1;
}

/** Parse one SSE frame into {event,data,id}. Returns null for comment-only frames. */
function parseFrame(frame: string): ParsedEvent | null {
  let event = "message";
  let id: string | null = null;
  const dataLines: string[] = [];
  let sawField = false;

  for (const rawLine of frame.split(/\r\n|\n|\r/)) {
    if (rawLine === "" || rawLine.startsWith(":")) continue; // comment / blank
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        event = value;
        sawField = true;
        break;
      case "data":
        dataLines.push(value);
        sawField = true;
        break;
      case "id":
        id = value;
        sawField = true;
        break;
      default:
        break; // ignore unknown fields (e.g. retry)
    }
  }

  if (!sawField) return null;
  return { event, data: dataLines.join("\n"), id };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
