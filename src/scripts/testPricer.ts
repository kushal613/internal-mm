/**
 * Quick sanity-check of the LogitDiffusionEngine against known limits.
 * Run: npx tsx src/scripts/testPricer.ts
 */
import { LogitDiffusionEngine } from "../pricing/logitMC.js";
import type { QuoteRequestMarket, QuoteRequestOption, QuoteRequestTrade } from "../types.js";

const market: QuoteRequestMarket = {
  conditionId: "0xtest",
  yesTokenId: "0",
  question: "test",
};

const engine = new LogitDiffusionEngine({ sigmab: 1.5, halfSpread: 0, mcPaths: 50_000 });

function test(
  label: string,
  p0: number,
  strikeBps: number,
  optionType: "call" | "put",
  tauDays: number,
  side: "buy" | "sell",
  isResolutionExpiry = false,
): void {
  const now = Date.now();
  const option: QuoteRequestOption = {
    optionType,
    strikeBps,
    expiryMs: now + tauDays * 24 * 3600 * 1000,
    isResolutionExpiry,
  };
  const trade: QuoteRequestTrade = { side, size: 100 };
  const t0 = performance.now();
  const d = engine.decide({ market: { ...market, yesPrice: p0 }, option, trade });
  const ms = (performance.now() - t0).toFixed(1);
  if (d) {
    console.log(`${label.padEnd(50)} fair=${d.fairValue!.toFixed(4)}  price=${d.price.toFixed(4)}  ${ms}ms`);
  } else {
    console.log(`${label.padEnd(50)} DECLINED  ${ms}ms`);
  }
}

console.log("=== Resolution expiry (exact, no vol dependence) ===");
test("Call p=0.50 K=50 (ATM resolution)",       0.50, 50, "call", 30, "sell", true);
test("Put  p=0.50 K=50 (ATM resolution)",       0.50, 50, "put",  30, "sell", true);
test("Call p=0.70 K=40 (ITM resolution)",        0.70, 40, "call", 30, "sell", true);
test("Put  p=0.30 K=40 (ITM resolution)",        0.30, 40, "put",  30, "sell", true);

console.log("\n=== Interim expiry (MC) ===");
test("Call p=0.50 K=50 τ=30d (ATM)",            0.50, 50, "call", 30, "sell");
test("Put  p=0.50 K=50 τ=30d (ATM)",            0.50, 50, "put",  30, "sell");
test("Call p=0.50 K=70 τ=30d (OTM)",            0.50, 70, "call", 30, "sell");
test("Call p=0.50 K=70 τ=90d (OTM, more time)", 0.50, 70, "call", 90, "sell");
test("Put  p=0.50 K=30 τ=30d (OTM)",            0.50, 30, "put",  30, "sell");
test("Call p=0.55 K=70 τ=90d (payoff-page ex)",  0.55, 70, "call", 90, "sell");

console.log("\n=== Sanity: very short τ → near intrinsic ===");
test("Call p=0.60 K=50 τ=1d (ITM, short)",      0.60, 50, "call", 1,  "sell");
test("Call p=0.40 K=50 τ=1d (OTM, short)",      0.40, 50, "call", 1,  "sell");

console.log("\n=== Put-call parity check: C - P ≈ p0 - K ===");
const p0 = 0.50, K = 40, tau = 60;
const callOpt: QuoteRequestOption = { optionType: "call", strikeBps: K, expiryMs: Date.now() + tau * 86400000 };
const putOpt:  QuoteRequestOption = { optionType: "put",  strikeBps: K, expiryMs: Date.now() + tau * 86400000 };
const tr: QuoteRequestTrade = { side: "sell", size: 100 };
const mkt: QuoteRequestMarket = { ...market, yesPrice: p0 };
const c = engine.decide({ market: mkt, option: callOpt, trade: tr })!;
const p = engine.decide({ market: mkt, option: putOpt,  trade: tr })!;
const diff = c.fairValue! - p.fairValue!;
const expected = p0 - K / 100;
console.log(`C=${c.fairValue!.toFixed(4)} P=${p.fairValue!.toFixed(4)} C-P=${diff.toFixed(4)} vs p0-K=${expected.toFixed(4)} (should match)`);
