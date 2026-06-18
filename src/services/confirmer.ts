import type { ethers } from "ethers";
import { createLogger } from "../logger.js";
import { formatUnits6 } from "../pricing/math.js";
import type { ConvallaxRest } from "../rest/client.js";
import { signOrder } from "../signing/order.js";
import type { QuoteStore } from "../state/store.js";
import type { WsQuoteAcceptedMessage } from "../types.js";

const log = createLogger("confirmer");

/**
 * Phase 3: when one of our quotes wins (quote:accepted), sign the EIP-712 order
 * with our own wallet key and POST the signature to /confirm before the
 * confirmationDeadline (default ~10s). Signing is offline/local, so the only
 * latency is the confirm HTTP round-trip. USDC approvals must already be set —
 * there's no time to approve here.
 */
export class Confirmer {
  constructor(
    private readonly rest: ConvallaxRest,
    private readonly store: QuoteStore,
    private readonly wallet: ethers.Wallet,
  ) {}

  async onAccepted(msg: WsQuoteAcceptedMessage): Promise<void> {
    const started = Date.now();
    const deadlineMs = Date.parse(msg.confirmationDeadline);
    const remaining = Number.isNaN(deadlineMs) ? undefined : deadlineMs - started;

    log.info("WON — signing + confirming", {
      requestId: msg.requestId,
      quoteId: msg.quoteId,
      seriesId: msg.order.seriesId,
      makerSelling: msg.order.makerSelling,
      role: msg.order.makerSelling ? "writer (post collateral)" : "holder (pay premium)",
      premiumUSDC: formatUnits6(BigInt(msg.order.premiumAmount)),
      optionAmount: formatUnits6(BigInt(msg.order.optionAmount)),
      remainingMs: remaining,
    });

    if (remaining !== undefined && remaining <= 0) {
      log.warn("confirmation deadline already passed — attempting anyway", {
        requestId: msg.requestId,
      });
    }

    let signature: string;
    try {
      signature = await signOrder(this.wallet, msg.domain, msg.types, msg.order);
    } catch (err) {
      log.error("refusing/failed to sign order — NOT confirming", {
        requestId: msg.requestId,
        err: String(err),
      });
      return;
    }

    try {
      const res = await this.rest.confirmQuote(msg.quoteId, signature);
      const elapsed = Date.now() - started;
      if (res.success) {
        log.info("confirmed — awaiting taker fill()", {
          requestId: msg.requestId,
          quoteId: msg.quoteId,
          elapsedMs: elapsed,
        });
      } else {
        log.warn("confirm returned non-success", { requestId: msg.requestId, elapsedMs: elapsed });
      }
    } catch (err) {
      log.error("confirm POST failed", { requestId: msg.requestId, err: String(err) });
    }
  }
}
