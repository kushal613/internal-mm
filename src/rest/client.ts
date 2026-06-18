import { config } from "../config.js";
import { PATHS } from "../constants.js";
import { createLogger } from "../logger.js";
import type {
  MarketsListResponse,
  QuoteSubmission,
  RelayStatus,
  SeriesFilter,
  SeriesListResponse,
  SubmitQuoteResponse,
} from "../types.js";

const log = createLogger("rest");

export class ConvallaxRestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ConvallaxRestError";
  }
}

/**
 * Thin REST wrapper for the maker + discovery endpoints.
 * Channel 2 (quote submit/confirm) and public discovery (status/markets/series/faucet).
 */
export class ConvallaxRest {
  private readonly base: string;
  private readonly apiKey: string | undefined;

  constructor(opts?: { apiKey?: string; base?: string }) {
    this.base = (opts?.base ?? config.apiBase).replace(/\/$/, "");
    this.apiKey = opts?.apiKey ?? config.apiKey;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts?: { query?: Record<string, string | undefined>; body?: unknown; auth?: boolean },
  ): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts?.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts?.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts?.auth) {
      if (!this.apiKey) throw new Error(`${path} requires an API key (X-API-Key) but none is set`);
      headers["X-API-Key"] = this.apiKey;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      const errMsg =
        (parsed as { error?: string })?.error ?? `${method} ${path} failed (${res.status})`;
      throw new ConvallaxRestError(errMsg, res.status, parsed);
    }
    return parsed as T;
  }

  /** GET /maker/v1/status — connectivity + connected maker counts. */
  getStatus(): Promise<RelayStatus> {
    return this.request<RelayStatus>("GET", PATHS.status);
  }

  /** GET /v1/markets — markets with registered option series. */
  listMarkets(): Promise<MarketsListResponse> {
    return this.request<MarketsListResponse>("GET", PATHS.markets);
  }

  /** GET /v1/series — registered series, optionally filtered. */
  listSeries(filter?: SeriesFilter): Promise<SeriesListResponse> {
    return this.request<SeriesListResponse>("GET", PATHS.series, {
      query: {
        conditionId: filter?.conditionId,
        optionType: filter?.optionType,
        settled: filter?.settled === undefined ? undefined : String(filter.settled),
      },
    });
  }

  /** POST /faucet — drip testnet USDC (1,000 USDC, 24h cooldown per wallet). */
  requestFaucet(wallet: string): Promise<unknown> {
    return this.request("POST", PATHS.faucet, { body: { wallet } });
  }

  /** POST /v1/mm/quotes — submit or update a quote (Channel 2). Returns server quoteId. */
  submitQuote(requestId: string, quote: QuoteSubmission): Promise<SubmitQuoteResponse> {
    log.debug("submitQuote", { requestId, price: quote.price, size: quote.size });
    return this.request<SubmitQuoteResponse>("POST", PATHS.submitQuote, {
      auth: true,
      body: { requestId, quote },
    });
  }

  /** POST /v1/mm/quotes/:quoteId/confirm — submit the EIP-712 signature (Channel 2). */
  confirmQuote(quoteId: string, signature: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>("POST", PATHS.confirmQuote(quoteId), {
      auth: true,
      body: { signature },
    });
  }
}
