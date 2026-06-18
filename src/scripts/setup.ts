import { ethers } from "ethers";
import { config } from "../config.js";
import { CONTRACTS, EXPECTED_MAKER_WALLET, MAKER_ID } from "../constants.js";
import { createLogger } from "../logger.js";
import {
  APPROVAL_MIN_RAW,
  MAX_UINT256,
  ensureApproval,
  getProvider,
  getWallet,
  readOnchainStatus,
} from "../onchain/usdc.js";
import { formatUnits6 } from "../pricing/math.js";
import { ConvallaxRest } from "../rest/client.js";

const log = createLogger("setup");

/**
 * Phase 0 setup / preflight:
 *   npm run setup            -> status, market discovery, balances, allowances
 *   npm run setup -- --faucet -> also request testnet USDC
 *   npm run setup -- --approve -> also set USDC approvals (Core + Settlement)
 *
 * Designed to be safe to run repeatedly; on-chain actions are gated behind flags
 * and skipped when already satisfied.
 */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const doApprove = args.has("--approve");
  const doFaucet = args.has("--faucet");

  const rest = new ConvallaxRest();

  log.info("identity", { makerId: MAKER_ID, expectedWallet: EXPECTED_MAKER_WALLET });

  // 1. Relay connectivity
  try {
    const status = await rest.getStatus();
    log.info("relay status", {
      protocolVersion: status.protocolVersion,
      makersConnected: status.makersConnected,
      socketsConnected: status.socketsConnected,
    });
  } catch (err) {
    log.error("failed to reach relay status", { err: String(err) });
  }

  // 2. Market / series discovery
  try {
    const { markets, count } = await rest.listMarkets();
    log.info(`markets available: ${count}`);
    for (const m of markets) {
      log.info(`  - ${m.name}`, {
        conditionId: m.conditionId,
        seriesCount: m.seriesCount,
        strikesBps: m.strikes,
        optionTypes: m.optionTypes,
        expiries: m.expiries,
      });
    }
  } catch (err) {
    log.error("failed to list markets", { err: String(err) });
  }

  // 3. On-chain preflight (needs MM_PRIVATE_KEY)
  if (!config.privateKey) {
    log.warn("MM_PRIVATE_KEY not set — skipping on-chain balance/allowance checks");
    log.info("setup complete (read-only)");
    return;
  }

  const provider = getProvider();
  const net = await provider.getNetwork();
  log.info("rpc network", { chainId: Number(net.chainId), rpc: config.rpcUrl });

  const wallet = getWallet(provider);
  if (wallet.address.toLowerCase() !== EXPECTED_MAKER_WALLET.toLowerCase()) {
    log.warn("wallet from MM_PRIVATE_KEY does not match the registered maker wallet", {
      derived: wallet.address,
      expected: EXPECTED_MAKER_WALLET,
    });
  }

  if (doFaucet) {
    try {
      log.info("requesting testnet USDC from faucet...");
      const res = await rest.requestFaucet(wallet.address);
      log.info("faucet response", { res });
    } catch (err) {
      log.error("faucet request failed (cooldown is 24h/wallet)", { err: String(err) });
    }
  }

  const status = await readOnchainStatus(wallet);
  log.info("wallet balances", {
    wallet: status.wallet,
    pol: ethers.formatEther(status.pol),
    usdc: formatUnits6(status.usdc),
    allowanceCore: formatUnits6(status.allowanceCore),
    allowanceSettlement: formatUnits6(status.allowanceSettlement),
  });

  if (status.pol === 0n) {
    log.warn("no POL for gas — fund the wallet via the Polygon Amoy faucet before approving/signing");
  }

  if (doApprove) {
    log.info("ensuring USDC approvals (Core for collateral, Settlement for premium)...");
    const coreTx = await ensureApproval(wallet, CONTRACTS.core, MAX_UINT256, APPROVAL_MIN_RAW);
    log.info(coreTx ? `approved Core: ${coreTx}` : "Core approval already sufficient");
    const settleTx = await ensureApproval(
      wallet,
      CONTRACTS.settlement,
      MAX_UINT256,
      APPROVAL_MIN_RAW,
    );
    log.info(settleTx ? `approved Settlement: ${settleTx}` : "Settlement approval already sufficient");
  } else {
    const needCore = status.allowanceCore < APPROVAL_MIN_RAW;
    const needSettle = status.allowanceSettlement < APPROVAL_MIN_RAW;
    if (needCore || needSettle) {
      log.warn("USDC approvals not fully set — run `npm run approve` before quoting", {
        needCore,
        needSettle,
      });
    } else {
      log.info("USDC approvals look sufficient");
    }
  }

  log.info("setup complete");
}

main().catch((err) => {
  log.error("setup failed", { err: String(err) });
  process.exitCode = 1;
});
