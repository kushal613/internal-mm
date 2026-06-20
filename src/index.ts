import { config, requireApiKey } from "./config.js";
import { EXPECTED_MAKER_WALLET, MAKER_ID } from "./constants.js";
import { createLogger } from "./logger.js";
import {
  APPROVAL_MIN_RAW,
  getProvider,
  getWallet,
  readOnchainStatus,
} from "./onchain/usdc.js";
import { LogitDiffusionEngine } from "./pricing/logitMC.js";
import { formatUnits6 } from "./pricing/math.js";
import { ConvallaxRest } from "./rest/client.js";
import { Confirmer } from "./services/confirmer.js";
import { Quoter } from "./services/quoter.js";
import { QuoteStore } from "./state/store.js";
import { QuoteRequestStream } from "./transport/sse.js";
import { PostTradeSocket } from "./transport/ws.js";
import { normalizeOptionType } from "./types.js";
import { ethers } from "ethers";

const log = createLogger("listener");

/**
 * Phases 1-3 entrypoint.
 *
 *  - With MM_PRIVATE_KEY set  -> LIVE mode: quote every request (Phase 2) and
 *    sign+confirm on wins (Phase 3) using the placeholder pricing engine.
 *  - Without MM_PRIVATE_KEY   -> READ-ONLY mode: just observe (Phase 1).
 *
 * The proprietary pricing model (Phase 4) and risk/capital controls (Phase 5)
 * are not here yet — the placeholder engine should not be trusted for real edge.
 */
async function main(): Promise<void> {
  const apiKey = requireApiKey();
  const rest = new ConvallaxRest({ apiKey });
  const store = new QuoteStore();
  const engine = new LogitDiffusionEngine({
    sigmab: 1.5,       // annualized belief-vol in logit space
    halfSpread: 0.02,  // 2% half-spread (4% round-trip)
  });

  log.info("starting Convallax MM", {
    makerId: MAKER_ID,
    apiBase: config.apiBase,
    wsBase: config.wsBase,
  });

  let quoter: Quoter | undefined;
  let confirmer: Confirmer | undefined;
  let wallet: ethers.Wallet | undefined;

  if (config.privateKey) {
    wallet = getWallet(getProvider());
    if (wallet.address.toLowerCase() !== EXPECTED_MAKER_WALLET.toLowerCase()) {
      log.warn("wallet from MM_PRIVATE_KEY does not match the registered maker wallet", {
        derived: wallet.address,
        expected: EXPECTED_MAKER_WALLET,
      });
    }
    quoter = new Quoter(rest, store, engine, wallet.address);
    confirmer = new Confirmer(rest, store, wallet);
    await preflight(wallet);
    log.info("LIVE quoting mode enabled", { maker: wallet.address });
  } else {
    log.warn("MM_PRIVATE_KEY not set — READ-ONLY mode (no quotes submitted)");
  }

  try {
    const status = await rest.getStatus();
    log.info("relay reachable", {
      protocolVersion: status.protocolVersion,
      makersConnected: status.makersConnected,
    });
  } catch (err) {
    log.warn("could not fetch relay status (continuing)", { err: String(err) });
  }

  // --- Channel 1: SSE quote-request stream ---
  const stream = new QuoteRequestStream(apiKey);

  stream.on("quote_request", (req) => {
    store.upsertRequest(req);
    const o = req.params.option;
    const t = req.params.trade;
    log.info("quote_request", {
      requestId: req.requestId,
      question: req.params.market.question,
      type: normalizeOptionType(o.optionType),
      strikeBps: o.strikeBps,
      expiryMs: o.expiryMs,
      side: t.side,
      ...(t.side === "buy" ? { budgetUsd: t.budgetUsd } : { size: t.size }),
      open: store.openCount,
    });
    if (quoter) void quoter.onQuoteRequest(req);
  });

  stream.on("quote_request_expired", (requestId) => {
    store.remove(requestId);
    log.info("quote_request_expired", { requestId, open: store.openCount });
  });

  stream.on("error", () => {
    /* logged in transport; EventSource auto-retries */
  });

  // --- Channel 3: post-trade WebSocket ---
  const ws = new PostTradeSocket(apiKey);

  ws.on("connected", (msg) => {
    if (msg.makerId !== MAKER_ID) {
      log.warn("connected makerId differs from expected", { got: msg.makerId, expected: MAKER_ID });
    }
  });

  ws.on("accepted", (msg) => {
    if (confirmer) {
      void confirmer.onAccepted(msg);
    } else {
      log.warn("WON but no signer configured (read-only) — cannot confirm", {
        requestId: msg.requestId,
        quoteId: msg.quoteId,
      });
    }
  });

  ws.on("confirmed", (msg) => log.info("quote:confirmed", { requestId: msg.requestId }));
  ws.on("rejected", (msg) =>
    log.info("quote:rejected", { requestId: msg.requestId, reason: msg.reason }),
  );
  ws.on("authError", () => {
    log.error("WebSocket auth failed — shutting down");
    shutdown(1);
  });

  stream.start();
  ws.start();

  let shuttingDown = false;
  function shutdown(code = 0): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down");
    stream.close();
    ws.close();
    setTimeout(() => process.exit(code), 250);
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

/** On-chain preflight so we don't win quotes we can't actually settle. */
async function preflight(wallet: ethers.Wallet): Promise<void> {
  try {
    const st = await readOnchainStatus(wallet);
    log.info("wallet preflight", {
      wallet: st.wallet,
      pol: ethers.formatEther(st.pol),
      usdc: formatUnits6(st.usdc),
      allowanceCore: formatUnits6(st.allowanceCore),
      allowanceSettlement: formatUnits6(st.allowanceSettlement),
    });
    if (st.pol === 0n) {
      log.warn("no POL for gas — claims/approvals will fail (fund via Polygon Amoy faucet)");
    }
    if (st.allowanceCore < APPROVAL_MIN_RAW || st.allowanceSettlement < APPROVAL_MIN_RAW) {
      log.warn("USDC approvals not fully set — winning quotes may fail to settle. Run `npm run approve`", {
        coreOk: st.allowanceCore >= APPROVAL_MIN_RAW,
        settlementOk: st.allowanceSettlement >= APPROVAL_MIN_RAW,
      });
    }
  } catch (err) {
    log.warn("on-chain preflight failed (continuing)", { err: String(err) });
  }
}

main().catch((err) => {
  log.error("fatal", { err: String(err) });
  process.exitCode = 1;
});
