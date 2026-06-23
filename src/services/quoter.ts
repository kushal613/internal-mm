import { createLogger } from "../logger.js";
import type { PricingEngine } from "../pricing/engine.js";
import { clampPrice, noArbMaxPrice } from "../pricing/math.js";
import type { ConvallaxRest } from "../rest/client.js";
import type { QuoteStore } from "../state/store.js";
import { normalizeOptionType, type QuoteRequestEvent } from "../types.js";

const log = createLogger("quoter");

/**
 * Phase 2: turn an incoming quote_request into a submitted quote.
 *
 * Flow: pricing engine -> local validation (mirror relay rules to avoid wasted
 * round-trips) -> POST /v1/mm/quotes -> store the server quoteId so we can confirm
 * if we win. Re-POSTing for the same requestId updates the quote (only the latest
 * is kept), so this is safe to call again on snapshot replay after a reconnect.
 */
export class Quoter {
  constructor(
    private readonly rest: ConvallaxRest,
    private readonly store: QuoteStore,
    private readonly engine: PricingEngine,
    private readonly makerAddress: string,
  ) {}

  async onQuoteRequest(req: QuoteRequestEvent): Promise<void> {
    const { market, option, trade } = req.params;

    const decision = this.engine.decide({ market, option, trade });
    if (!decision) {
      log.debug("engine declined to quote", { requestId: req.requestId });
      return;
    }

    // Validate locally against the documented relay rules (side-specific sizing).
    if (trade.side === "buy") {
      // Buys carry a USDC budget; a quote is valid as long as size >= 1.
      if (!(decision.size >= 1)) {
        log.warn("buy quote size < 1 — skipping", {
          requestId: req.requestId,
          size: decision.size,
          budgetUsd: trade.budgetUsd,
        });
        return;
      }
    } else {
      // Sells carry a contract count; size must be >= 50% of requested.
      const requested = Number(trade.size);
      if (!Number.isFinite(requested) || decision.size < requested * 0.5) {
        log.warn("sell quote size below 50% of requested — skipping", {
          requestId: req.requestId,
          size: decision.size,
          requested: trade.size,
        });
        return;
      }
    }

    const price = clampPrice(decision.price, option.optionType, option.strikeBps);
    if (!(price > 0 && price < 1)) {
      log.warn("price outside (0,1) after clamp — skipping", { requestId: req.requestId, price });
      return;
    }
    const noArbMax = noArbMaxPrice(option.optionType, option.strikeBps);
    if (price > noArbMax) {
      log.warn("price exceeds no-arb max — skipping", { requestId: req.requestId, price, noArbMax });
      return;
    }

    try {
      const res = await this.rest.submitQuote(req.requestId, {
        maker: this.makerAddress,
        side: trade.side,
        price,
        size: decision.size,
        fairValue: decision.fairValue,
        spread_bps: decision.spreadBps,
      });

      if (res.success && res.quoteId) {
        this.store.setQuote(req.requestId, res.quoteId, price, decision.size);
        log.info("quoted", {
          requestId: req.requestId,
          quoteId: res.quoteId,
          type: normalizeOptionType(option.optionType),
          strikeBps: option.strikeBps,
          side: trade.side,
          price: Number(price.toFixed(4)),
          size: decision.size,
        });
      } else {
        log.warn("quote not accepted by relay", { requestId: req.requestId, error: res.error });
      }
    } catch (err) {
      // Request may have expired/closed between SSE event and our POST — that's fine.
      log.warn("submitQuote failed", { requestId: req.requestId, err: String(err) });
    }
  }
}
