import { clampPrice, noArbMaxPrice } from "./math.js";
import { normalizeOptionType, type OptionType, type QuoteRequestOption, type QuoteRequestTrade, type Side } from "../types.js";

/**
 * Pricing engine interface.
 *
 * NOTE (Phase 4): The real quoting model is OURS to build. Convallax-provided
 * `sigmaL` / `currentYesPrice` / `tauDays` are only *suggestions*. This file is a
 * deliberately naive placeholder so the transport layer can be exercised end to
 * end before the proprietary model lands. It is NOT wired into live quoting yet.
 */
export interface QuoteDecision {
  /** Price per option in (0,1). undefined => do not quote. */
  price: number;
  /** Whole options to quote (must be >= 50% of requested size to be valid). */
  size: number;
  fairValue?: number;
  spreadBps?: number;
}

export interface PricingEngine {
  decide(input: {
    option: QuoteRequestOption;
    trade: QuoteRequestTrade;
  }): QuoteDecision | undefined;
}

/**
 * Placeholder model: anchor to currentYesPrice with a flat spread and a hard
 * no-arb clamp. Replace entirely with the proprietary model in Phase 4.
 */
export class NaivePlaceholderEngine implements PricingEngine {
  /**
   * @param halfSpread   half the quoted spread around fair value
   * @param maxContracts hard cap on whole options we'll write in a single quote.
   *                     Defaults to no cap (testnet); Phase 5 should set a real
   *                     limit sized off available capital.
   */
  constructor(
    private readonly halfSpread = 0.03,
    private readonly maxContracts = Number.POSITIVE_INFINITY,
  ) {}

  decide({ option, trade }: { option: QuoteRequestOption; trade: QuoteRequestTrade }):
    | QuoteDecision
    | undefined {
    // strikeBps defines the no-arb bound; if it's unusable we cannot price safely.
    const strikeBps = Number(option.strikeBps);
    if (!Number.isFinite(strikeBps) || strikeBps <= 0 || strikeBps >= 100) return undefined;

    const type = normalizeOptionType(option.optionType);
    const max = noArbMaxPrice(type, strikeBps); // 1-K (call) or K (put), in (0,1)

    const fair = this.fairValue(type, strikeBps, option.currentYesPrice, max);
    const price = clampPrice(this.applySpread(fair, trade.side), option.optionType, strikeBps);
    if (!Number.isFinite(price)) return undefined; // belt-and-suspenders

    const size = this.sizeFor(trade, price);
    if (!Number.isFinite(size) || size < 1) return undefined; // nothing we can fill

    return {
      price,
      size,
      fairValue: fair,
      spreadBps: Math.round(this.halfSpread * 2 * 10_000),
    };
  }

  /**
   * Whole options we'll quote:
   *  - buy:  taker submits a USDC budget; the most they could take is floor(budget/price).
   *          We offer up to that, capped by our own maxContracts risk limit.
   *  - sell: taker submits a contract count; we take the full requested size.
   */
  private sizeFor(trade: QuoteRequestTrade, price: number): number {
    if (trade.side === "buy") {
      const budget = Number(trade.budgetUsd);
      if (Number.isFinite(budget) && budget > 0 && price > 0) {
        return Math.min(Math.floor(budget / price), this.maxContracts);
      }
      // Transition fallback: some buys still arrive with a legacy contract count.
      const legacy = Number(trade.size);
      if (Number.isFinite(legacy) && legacy >= 1) {
        return Math.min(Math.floor(legacy), this.maxContracts);
      }
      return 0;
    }
    const size = Number(trade.size);
    return Number.isFinite(size) ? Math.floor(size) : 0;
  }

  /**
   * Crude intrinsic-value anchor, bounded to [0, maxPayoff] and robust to missing
   * inputs (a null/NaN currentYesPrice falls back to 0.5). Carries no time value —
   * deliberately simple; real edge comes in the Phase 4 model.
   */
  private fairValue(
    type: OptionType,
    strikeBps: number,
    rawYes: number | undefined,
    max: number,
  ): number {
    const k = strikeBps / 100;
    let s = Number(rawYes);
    if (!Number.isFinite(s)) s = 0.5;
    s = Math.min(Math.max(s, 0), 1);
    const intrinsic = type === "call" ? Math.max(0, s - k) : Math.max(0, k - s);
    return Math.min(Math.max(intrinsic, 0), max);
  }

  private applySpread(fair: number, side: Side): number {
    // Taker buys -> we ask higher; taker sells -> we bid lower.
    return side === "buy" ? fair + this.halfSpread : fair - this.halfSpread;
  }
}
