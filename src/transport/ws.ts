import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "../config.js";
import { PATHS } from "../constants.js";
import { createLogger } from "../logger.js";
import type {
  WsConnectedMessage,
  WsMessage,
  WsQuoteAcceptedMessage,
  WsQuoteConfirmedMessage,
  WsQuoteRejectedMessage,
} from "../types.js";

const log = createLogger("ws");

const AUTH_FAILED_CODE = 4001;

export interface PostTradeSocketEvents {
  connected: (msg: WsConnectedMessage) => void;
  accepted: (msg: WsQuoteAcceptedMessage) => void;
  confirmed: (msg: WsQuoteConfirmedMessage) => void;
  rejected: (msg: WsQuoteRejectedMessage) => void;
  authError: () => void;
  close: (code: number) => void;
}

/**
 * Channel 3: post-trade WebSocket (server -> maker). Delivers quote:accepted /
 * quote:confirmed / quote:rejected. Auth via ?apiKey=. Auto-reconnects with
 * exponential backoff; stops permanently on auth failure (close code 4001).
 */
export class PostTradeSocket extends EventEmitter {
  private ws: WebSocket | undefined;
  private closedByUser = false;
  private backoffMs = 1_000;
  private readonly maxBackoffMs = 30_000;
  private appPingTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly apiKey: string,
    private readonly base: string = config.wsBase,
  ) {
    super();
  }

  override on<E extends keyof PostTradeSocketEvents>(
    event: E,
    listener: PostTradeSocketEvents[E],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<E extends keyof PostTradeSocketEvents>(
    event: E,
    ...args: Parameters<PostTradeSocketEvents[E]>
  ): boolean {
    return super.emit(event, ...args);
  }

  start(): void {
    this.closedByUser = false;
    this.connect();
  }

  private connect(): void {
    const url = `${this.base.replace(/\/$/, "")}${PATHS.makerWs}?apiKey=${encodeURIComponent(
      this.apiKey,
    )}`;
    log.info("connecting");
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      log.debug("socket open; awaiting connected message");
      this.startAppPing();
    });

    // `ws` auto-responds to protocol pings, but mirror the documented pattern.
    ws.on("ping", () => ws.pong());

    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        log.warn("non-JSON message", { err: String(err) });
        return;
      }
      this.dispatch(msg);
    });

    ws.on("close", (code: number) => {
      this.stopAppPing();
      if (code === AUTH_FAILED_CODE) {
        log.error("authentication failed (4001) — check CONVALLAX_API_KEY; not reconnecting");
        this.emit("authError");
        return;
      }
      this.emit("close", code);
      if (this.closedByUser) {
        log.info("socket closed by user");
        return;
      }
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      log.warn("socket closed; reconnecting", { code, delayMs: delay });
      setTimeout(() => {
        if (!this.closedByUser) this.connect();
      }, delay);
    });

    ws.on("error", (err: Error) => {
      log.warn("socket error", { err: err.message });
    });
  }

  private dispatch(msg: WsMessage): void {
    switch (msg.type) {
      case "connected":
        this.backoffMs = 1_000; // reset backoff on a healthy connection
        log.info("connected", { protocolVersion: msg.protocolVersion, makerId: msg.makerId });
        this.emit("connected", msg);
        break;
      case "quote:accepted":
        this.emit("accepted", msg);
        break;
      case "quote:confirmed":
        this.emit("confirmed", msg);
        break;
      case "quote:rejected":
        this.emit("rejected", msg);
        break;
      case "pong":
        log.debug("pong", { timestamp: msg.timestamp });
        break;
      default:
        log.debug("unhandled message", { msg });
    }
  }

  private startAppPing(): void {
    this.stopAppPing();
    this.appPingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 25_000);
  }

  private stopAppPing(): void {
    if (this.appPingTimer) clearInterval(this.appPingTimer);
    this.appPingTimer = undefined;
  }

  close(): void {
    this.closedByUser = true;
    this.stopAppPing();
    this.ws?.close();
    this.ws = undefined;
    log.info("closed");
  }
}
