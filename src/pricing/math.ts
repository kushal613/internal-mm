import { ONE_UNIT } from "../constants.js";
import { normalizeOptionType, type OptionType } from "../types.js";

/**
 * Protocol-defined unit / collateral / payoff math (NOT a pricing model).
 * These mirror the on-chain formulas in OptionMath and are exact / integer-based.
 *
 * Important: per the Convallax team, the backend uses the *maker's quoted size*
 * verbatim when building the order — so collateral/premium must be computed from
 * the size WE quote, not the taker's requested size.
 */

/** Raw option amount (6 decimals) for a whole-option size. */
export function optionAmountRaw(size: number): bigint {
  return BigInt(Math.round(size * Number(ONE_UNIT)));
}

/** Raw USDC premium (6 decimals) = price * size, integer-floored to raw units. */
export function premiumRaw(price: number, size: number): bigint {
  return BigInt(Math.floor(price * size * Number(ONE_UNIT)));
}

/**
 * Writer collateral required (raw USDC, 6 decimals) = max holder payout.
 *   Call: optionAmount * (100 - strikeBps) / 100
 *   Put:  optionAmount * strikeBps / 100
 * Uses integer division to match on-chain behavior.
 */
export function requiredCollateralRaw(
  optionType: OptionType | 0 | 1,
  strikeBps: number,
  size: number,
): bigint {
  const amount = optionAmountRaw(size);
  const k = BigInt(strikeBps);
  return normalizeOptionType(optionType) === "call"
    ? (amount * (100n - k)) / 100n
    : (amount * k) / 100n;
}

/**
 * No-arbitrage maximum price (per option, in dollars) the relay will accept:
 *   Call: 1 - K
 *   Put:  K
 * where K = strikeBps / 100.
 */
export function noArbMaxPrice(optionType: OptionType | 0 | 1, strikeBps: number): number {
  const k = strikeBps / 100;
  return normalizeOptionType(optionType) === "call" ? 1 - k : k;
}

/**
 * Clamp a price into the valid open interval (0,1) intersected with no-arb bounds.
 * Returns NaN for non-finite input so callers can detect/skip rather than silently
 * submit a garbage quote.
 */
export function clampPrice(price: number, optionType: OptionType | 0 | 1, strikeBps: number): number {
  if (!Number.isFinite(price)) return NaN;
  const max = Math.min(noArbMaxPrice(optionType, strikeBps), 1);
  // Keep strictly inside (0, max); the relay rejects price <= 0 or >= 1.
  const eps = 1e-6;
  return Math.min(Math.max(price, eps), Math.max(eps, max - eps));
}

/** Format raw 6-decimal units as a human dollar/option string. */
export function formatUnits6(raw: bigint): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const whole = abs / ONE_UNIT;
  const frac = (abs % ONE_UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
