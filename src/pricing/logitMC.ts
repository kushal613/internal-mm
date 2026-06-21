/**
 * Phase 4 pricing engine: European options on a [0,1]-bounded underlying
 * priced via Monte Carlo in logit space under the risk-neutral martingale
 * measure.
 *
 * Theory (from "Toward Black-Scholes for Prediction Markets"):
 *   Let p_t ∈ (0,1) be the YES price and x_t = logit(p_t) its log-odds.
 *   Under Q, p_t is a martingale. This pins the drift of x_t:
 *       μ(x) = -½ · (1 - 2p) · σ_b²
 *   leaving belief-volatility σ_b as the single quotable risk factor
 *   (diffusion-only; jumps can be layered on later).
 *
 *   Fair value = E_Q[ payoff(p_T) ]  where
 *     call payoff = max(p_T - K, 0)
 *     put  payoff = max(K - p_T, 0)
 *
 * Settlement: S_T is the Polymarket YES VWAP over the 30 min before expiry.
 */

import { clampPrice, noArbMaxPrice } from "./math.js";
import {
  normalizeOptionType,
  type QuoteRequestOption,
  type QuoteRequestTrade,
  type Side,
} from "../types.js";
import type { PricingEngine, QuoteDecision } from "./engine.js";

// ────────────────────────────────────────────────────────────
//  Logit / sigmoid helpers
// ────────────────────────────────────────────────────────────

function sigmoid(x: number): number {
  if (x > 500) return 1 - 1e-15;
  if (x < -500) return 1e-15;
  return 1 / (1 + Math.exp(-x));
}

function logit(p: number): number {
  return Math.log(p / (1 - p));
}

/**
 * Risk-neutral drift of x_t ensuring p_t = sigmoid(x_t) is a Q-martingale.
 * Derived from Itô's formula applied to S(x) with the martingale condition:
 *   μ(x) = -½ · S''(x)/S'(x) · σ² = -½ · (1 - 2p) · σ²
 */
function rnDrift(p: number, sigmaSq: number): number {
  return -0.5 * (1 - 2 * p) * sigmaSq;
}

// ────────────────────────────────────────────────────────────
//  Normal random variates (Box-Muller, cached pairs)
// ────────────────────────────────────────────────────────────

let _spare: number | undefined;
function normalRandom(): number {
  if (_spare !== undefined) {
    const v = _spare;
    _spare = undefined;
    return v;
  }
  let u: number, v: number, s: number;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  const mul = Math.sqrt(-2 * Math.log(s) / s);
  _spare = v * mul;
  return u * mul;
}

// ────────────────────────────────────────────────────────────
//  Monte Carlo pricer
// ────────────────────────────────────────────────────────────

interface MCResult {
  fairValue: number;
  stdError: number;
}

/**
 * Price a European option on p_T via Euler-Maruyama simulation of x_t
 * in logit space with antithetic variates for variance reduction.
 *
 * Each pair of paths shares the same Brownian draws (z and -z), halving
 * variance at negligible extra cost.
 */
function priceOptionMC(
  p0: number,
  strike: number,
  tauYears: number,
  sigma: number,
  isCall: boolean,
  nPaths: number,
  nSteps: number,
): MCResult {
  const pClamped = Math.min(Math.max(p0, 1e-8), 1 - 1e-8);
  const x0 = logit(pClamped);
  const sigmaSq = sigma * sigma;
  const dt = tauYears / nSteps;
  const sqrtDt = Math.sqrt(dt);

  const nPairs = Math.ceil(nPaths / 2);
  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < nPairs; i++) {
    let x1 = x0;
    let x2 = x0;
    for (let j = 0; j < nSteps; j++) {
      const z = normalRandom();
      const p1 = sigmoid(x1);
      const p2 = sigmoid(x2);
      x1 += rnDrift(p1, sigmaSq) * dt + sigma * sqrtDt * z;
      x2 += rnDrift(p2, sigmaSq) * dt - sigma * sqrtDt * z;
    }
    const pT1 = sigmoid(x1);
    const pT2 = sigmoid(x2);
    const pay1 = isCall ? Math.max(0, pT1 - strike) : Math.max(0, strike - pT1);
    const pay2 = isCall ? Math.max(0, pT2 - strike) : Math.max(0, strike - pT2);
    const avg = (pay1 + pay2) * 0.5;
    sum += avg;
    sumSq += avg * avg;
  }

  const mean = sum / nPairs;
  const variance = sumSq / nPairs - mean * mean;
  const stdError = Math.sqrt(Math.max(0, variance) / nPairs);
  return { fairValue: mean, stdError };
}

/**
 * Resolution-expiry pricing: p_T ∈ {0, 1} (Bernoulli with P(1) = p0).
 * Exact and volatility-independent.
 */
function priceResolutionExpiry(p0: number, strike: number, isCall: boolean): number {
  return isCall
    ? p0 * Math.max(0, 1 - strike)          // P(p_T=1) · max(1-K, 0)
    : (1 - p0) * Math.max(0, strike);       // P(p_T=0) · max(K-0, 0)
}

// ────────────────────────────────────────────────────────────
//  Pricing Engine
// ────────────────────────────────────────────────────────────

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

export interface LogitDiffusionConfig {
  /** Annualized belief-volatility in logit space (σ_b per √year). */
  sigmab?: number;
  /** Half the quoted spread around fair value (in price units, e.g. 0.02 = 2%). */
  halfSpread?: number;
  /** Hard cap on contracts per quote. */
  maxContracts?: number;
  /** MC simulation paths (more = slower but less noise). */
  mcPaths?: number;
  /** Target Euler steps per year of τ (actual steps = clamp(τ · this, 10, 200)). */
  mcStepsPerYear?: number;
}

export class LogitDiffusionEngine implements PricingEngine {
  private readonly sigmab: number;
  private readonly halfSpread: number;
  private readonly maxContracts: number;
  private readonly mcPaths: number;
  private readonly mcStepsPerYear: number;

  constructor(cfg: LogitDiffusionConfig = {}) {
    this.sigmab = cfg.sigmab ?? 1.5;
    this.halfSpread = cfg.halfSpread ?? 0.02;
    this.maxContracts = cfg.maxContracts ?? Number.POSITIVE_INFINITY;
    this.mcPaths = cfg.mcPaths ?? 10_000;
    this.mcStepsPerYear = cfg.mcStepsPerYear ?? 500;
  }

  decide({
    option,
    trade,
  }: {
    option: QuoteRequestOption;
    trade: QuoteRequestTrade;
  }): QuoteDecision | undefined {
    const strikeBps = Number(option.strikeBps);
    if (!Number.isFinite(strikeBps) || strikeBps <= 0 || strikeBps >= 100) return undefined;

    const type = normalizeOptionType(option.optionType);
    const isCall = type === "call";
    const strike = strikeBps / 100;

    // Current YES price (assume up-to-date per protocol design).
    let p0 = Number(option.currentYesPrice);
    if (!Number.isFinite(p0)) p0 = 0.5;
    p0 = Math.min(Math.max(p0, 1e-6), 1 - 1e-6);

    // Time to expiry.
    const tauYears = this.computeTau(option);
    if (tauYears === undefined || tauYears <= 0) return undefined;

    // ── Fair value ──
    let fair: number;
    if (option.isResolutionExpiry) {
      fair = priceResolutionExpiry(p0, strike, isCall);
    } else {
      const nSteps = Math.max(10, Math.min(200, Math.round(this.mcStepsPerYear * tauYears)));
      const mc = priceOptionMC(p0, strike, tauYears, this.sigmab, isCall, this.mcPaths, nSteps);
      fair = mc.fairValue;
    }

    if (!Number.isFinite(fair) || fair <= 0) return undefined;

    // Economic dominance bound: beyond this price, buying the underlying
    // (YES for calls, NO for puts) strictly dominates buying the option
    // for every possible S_T. No rational taker should pay more.
    //   Call: S₀ · (1 - K)     Put: (1 - S₀) · K
    const domBound = isCall ? p0 * (1 - strike) : (1 - p0) * strike;
    fair = Math.min(fair, domBound);
    if (fair <= 0) return undefined;

    // ── Quote price = fair ± spread, clamped to no-arb bounds ──
    const quoted = this.applySpread(fair, trade.side);
    const capped = Math.min(quoted, domBound);
    const price = clampPrice(capped, option.optionType, strikeBps);
    if (!Number.isFinite(price)) return undefined;

    // ── Size ──
    const size = this.sizeFor(trade, price);
    if (!Number.isFinite(size) || size < 1) return undefined;

    return {
      price,
      size,
      fairValue: fair,
      spreadBps: Math.round(this.halfSpread * 2 * 10_000),
    };
  }

  /** Compute τ in years from expiryMs (preferred) or tauDays (fallback). */
  private computeTau(option: QuoteRequestOption): number | undefined {
    const expiryMs = Number(option.expiryMs);
    if (Number.isFinite(expiryMs) && expiryMs > 0) {
      return (expiryMs - Date.now()) / MS_PER_YEAR;
    }
    const tauDays = Number(option.tauDays);
    if (Number.isFinite(tauDays) && tauDays > 0) {
      return tauDays / 365.25;
    }
    return undefined;
  }

  private applySpread(fair: number, side: Side): number {
    return side === "buy" ? fair + this.halfSpread : fair - this.halfSpread;
  }

  private sizeFor(trade: QuoteRequestTrade, price: number): number {
    if (trade.side === "buy") {
      const budget = Number(trade.budgetUsd);
      if (Number.isFinite(budget) && budget > 0 && price > 0) {
        return Math.min(Math.floor(budget / price), this.maxContracts);
      }
      const legacy = Number(trade.size);
      if (Number.isFinite(legacy) && legacy >= 1) {
        return Math.min(Math.floor(legacy), this.maxContracts);
      }
      return 0;
    }
    const size = Number(trade.size);
    return Number.isFinite(size) ? Math.floor(size) : 0;
  }
}
