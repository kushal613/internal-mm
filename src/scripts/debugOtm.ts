/**
 * Diagnostic: what does our engine produce for K=0.60 calls at various p0?
 * Run: npx tsx src/scripts/debugOtm.ts
 */
import { LogitDiffusionEngine } from "../pricing/logitMC.js";
import type { QuoteRequestMarket, QuoteRequestOption, QuoteRequestTrade } from "../types.js";

const engine = new LogitDiffusionEngine({ sigmab: 5.0, spreadFrac: 0.10, mcPaths: 50_000, minPrice: 0.001 });

function test(p0: number, strikeBps: number, optionType: "call" | "put", tauDays: number, side: "buy" | "sell"): void {
  const K = strikeBps / 100;
  const noArbMax = optionType === "call" ? 1 - K : K;
  const domBound = optionType === "call" ? p0 * (1 - K) : (1 - p0) * K;

  const market: QuoteRequestMarket = { conditionId: "test", yesTokenId: "test", question: "test", yesPrice: p0 } as any;
  const option: QuoteRequestOption = {
    optionType,
    strikeBps,
    expiryMs: Date.now() + tauDays * 86400000,
    currentYesPrice: p0,
  };
  const trade: QuoteRequestTrade = { side, size: 100 };
  const d = engine.decide({ market, option, trade });

  const label = `${optionType} p0=${p0} K=${K} τ=${tauDays}d ${side}`;
  if (d) {
    console.log(`${label.padEnd(42)} fair=${d.fairValue!.toFixed(6)}  price=${d.price.toFixed(6)}  noArbMax=${noArbMax.toFixed(2)}  domBound=${domBound.toFixed(4)}  size=${d.size}`);
  } else {
    console.log(`${label.padEnd(42)} DECLINED  noArbMax=${noArbMax.toFixed(2)}  domBound=${domBound.toFixed(4)}`);
  }
}

console.log("=== K=0.60 calls (Convallax diagnostic) ===");
console.log("noArbMax for K=0.60 call = 1-0.60 = 0.40\n");

for (const p0 of [0.30, 0.40, 0.50, 0.55, 0.60, 0.70, 0.80]) {
  const moneyness = p0 < 0.60 ? "OTM" : p0 === 0.60 ? "ATM" : "ITM";
  console.log(`--- p0=${p0} (${moneyness}) ---`);
  test(p0, 60, "call", 30, "buy");
  test(p0, 60, "call", 30, "sell");
  test(p0, 60, "call", 90, "buy");
}

console.log("\n=== K=0.60 puts for comparison ===");
for (const p0 of [0.50, 0.70, 0.80]) {
  test(p0, 60, "put", 30, "buy");
}

console.log("\n=== Sigma sensitivity for p0=0.50 K=0.60 call τ=60d ===");
for (const sig of [1.0, 1.5, 3.0, 5.0, 8.0, 12.0]) {
  const eng = new LogitDiffusionEngine({ sigmab: sig, spreadFrac: 0.10, mcPaths: 50_000, minPrice: 0.001 });
  const market: QuoteRequestMarket = { conditionId: "t", yesTokenId: "t", question: "t", yesPrice: 0.50 } as any;
  const option: QuoteRequestOption = { optionType: "call", strikeBps: 60, expiryMs: Date.now() + 60*86400000, currentYesPrice: 0.50 };
  const trade: QuoteRequestTrade = { side: "buy", size: 100 };
  const d = eng.decide({ market, option, trade });
  const label = `σ=${sig}`;
  if (d) {
    console.log(`${label.padEnd(10)} fair=${d.fairValue!.toFixed(6)}  price=${d.price.toFixed(6)}`);
  } else {
    console.log(`${label.padEnd(10)} DECLINED`);
  }
}
