import { ethers } from "ethers";
import { createLogger } from "../logger.js";
import { getProvider } from "../onchain/usdc.js";

const log = createLogger("decode");

/**
 * Replay a failed transaction against historical state to recover the revert
 * reason (standard Error(string) or a known Convallax/ERC20 custom error).
 *
 *   npx tsx src/scripts/decodeRevert.ts <txHash>
 */
const KNOWN_ERRORS = [
  "error InvalidAmount()",
  "error NonceAlreadyUsed()",
  "error OrderExpired()",
  "error InvalidSignature()",
  "error InvalidTaker()",
  "error EnforcedPause()",
  "error ExpectedPause()",
];

async function main(): Promise<void> {
  const hash = process.argv[2];
  if (!hash) throw new Error("usage: tsx src/scripts/decodeRevert.ts <txHash>");

  const provider = getProvider();
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(hash),
    provider.getTransactionReceipt(hash),
  ]);
  if (!tx || !receipt) throw new Error("transaction or receipt not found");

  log.info("tx", {
    from: tx.from,
    to: tx.to,
    block: receipt.blockNumber,
    status: receipt.status === 0 ? "FAILED" : "success",
    gasUsed: receipt.gasUsed.toString(),
  });

  const base = { to: tx.to, from: tx.from, data: tx.data, value: tx.value };
  // Replay at the block *before* inclusion to reproduce pre-tx state.
  for (const blockTag of [receipt.blockNumber - 1, receipt.blockNumber]) {
    try {
      await provider.call({ ...base, blockTag });
      log.info("replay did not revert at this block (state-dependent)", { blockTag });
    } catch (err) {
      decode(err, blockTag);
      return;
    }
  }
}

function decode(err: unknown, blockTag: number): void {
  const e = err as { shortMessage?: string; reason?: string; data?: string; info?: any };
  const data: string | undefined = e?.data ?? e?.info?.error?.data;
  log.info("REVERT captured", { blockTag, shortMessage: e?.shortMessage, reason: e?.reason });

  if (!data || data === "0x") {
    log.warn("no revert data returned (revert without reason, or RPC stripped it)");
    return;
  }

  // Standard Error(string)
  if (data.startsWith("0x08c379a0")) {
    const reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0];
    log.info("Error(string)", { reason });
    return;
  }
  // Panic(uint256)
  if (data.startsWith("0x4e487b71")) {
    const code = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + data.slice(10))[0];
    log.info("Panic", { code: code.toString() });
    return;
  }
  // Known custom errors
  try {
    const parsed = new ethers.Interface(KNOWN_ERRORS).parseError(data);
    log.info("custom error", { name: parsed?.name, args: parsed?.args?.map(String) });
  } catch {
    log.warn("unrecognized revert selector", { selector: data.slice(0, 10), data });
  }
}

main().catch((err) => {
  log.error("decode failed", { err: String(err) });
  process.exitCode = 1;
});
