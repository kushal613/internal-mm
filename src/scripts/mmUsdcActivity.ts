import { ethers } from "ethers";
import { CONTRACTS, EXPECTED_MAKER_WALLET } from "../constants.js";
import { createLogger } from "../logger.js";
import { getProvider } from "../onchain/usdc.js";
import { formatUnits6 } from "../pricing/math.js";

const log = createLogger("mm-usdc");

const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const MM = EXPECTED_MAKER_WALLET.toLowerCase();
const TAKER = "0xf4cfeaa4294af4052b4297de5f49edab999f63db";
const LABELS: Record<string, string> = {
  [CONTRACTS.settlement.toLowerCase()]: "Settlement",
  [CONTRACTS.core.toLowerCase()]: "Core",
  [TAKER]: "Taker",
  [MM]: "MM",
};

interface TransferEvent {
  block: number;
  tx: string;
  from: string;
  to: string;
  usdc: number;
  dir: "IN" | "OUT";
}

function label(addr: string): string {
  return LABELS[addr.toLowerCase()] ?? addr;
}

function classify(e: TransferEvent): string {
  if (e.dir === "IN" && e.from.toLowerCase() === TAKER) return "premium from buyer";
  if (e.dir === "OUT" && e.to.toLowerCase() === CONTRACTS.core.toLowerCase()) return "collateral to Core";
  if (e.dir === "IN" && e.from.toLowerCase() === CONTRACTS.settlement.toLowerCase()) return "from Settlement";
  if (e.dir === "OUT" && e.to.toLowerCase() === CONTRACTS.settlement.toLowerCase()) return "to Settlement";
  return "other";
}

async function main(): Promise<void> {
  const provider = getProvider();
  const usdc = new ethers.Contract(CONTRACTS.usdc, ["function balanceOf(address) view returns (uint256)"], provider);
  const bal = (await usdc.balanceOf!(EXPECTED_MAKER_WALLET)) as bigint;

  const head = await provider.getBlockNumber();
  const fromBlock = Math.max(0, head - 80_000);
  const chunk = 100;

  const mmTopic = ethers.zeroPadValue(EXPECTED_MAKER_WALLET, 32);
  async function chunkedLogs(
    topics: (string | null)[],
  ): Promise<ethers.Log[]> {
    const out: ethers.Log[] = [];
    for (let start = fromBlock; start <= head; start += chunk + 1) {
      const end = Math.min(head, start + chunk);
      out.push(
        ...(await provider.getLogs({
          address: CONTRACTS.usdc,
          fromBlock: start,
          toBlock: end,
          topics,
        })),
      );
    }
    return out;
  }

  const [outs, ins] = await Promise.all([
    chunkedLogs([TRANSFER, mmTopic]),
    chunkedLogs([TRANSFER, null, mmTopic]),
  ]);

  const events: TransferEvent[] = [];
  for (const lg of outs) {
    events.push({
      block: lg.blockNumber,
      tx: lg.transactionHash,
      from: ethers.getAddress(ethers.dataSlice(lg.topics[1]!, 12)),
      to: ethers.getAddress(ethers.dataSlice(lg.topics[2]!, 12)),
      usdc: Number(ethers.getBigInt(lg.data)) / 1e6,
      dir: "OUT",
    });
  }
  for (const lg of ins) {
    events.push({
      block: lg.blockNumber,
      tx: lg.transactionHash,
      from: ethers.getAddress(ethers.dataSlice(lg.topics[1]!, 12)),
      to: ethers.getAddress(ethers.dataSlice(lg.topics[2]!, 12)),
      usdc: Number(ethers.getBigInt(lg.data)) / 1e6,
      dir: "IN",
    });
  }

  events.sort((a, b) => b.block - a.block || a.dir.localeCompare(b.dir));

  log.info("maker wallet mock USDC", {
    wallet: EXPECTED_MAKER_WALLET,
    token: CONTRACTS.usdc,
    balance: formatUnits6(bal),
    balanceRaw: bal.toString(),
  });

  if (events.length === 0) {
    log.info("no mock USDC transfers involving MM in scanned range", { fromBlock, head });
    return;
  }

  log.info("recent mock USDC transfers involving MM", { count: events.length, fromBlock, head });
  for (const e of events.slice(0, 15)) {
    log.info("transfer", {
      block: e.block,
      dir: e.dir,
      usdc: e.usdc,
      from: label(e.from),
      to: label(e.to),
      kind: classify(e),
      tx: e.tx,
    });
  }

  const byTx = new Map<string, TransferEvent[]>();
  for (const e of events) {
    const list = byTx.get(e.tx) ?? [];
    list.push(e);
    byTx.set(e.tx, list);
  }
  const latestTx = [...byTx.entries()].sort((a, b) => (b[1][0]?.block ?? 0) - (a[1][0]?.block ?? 0))[0];
  if (latestTx) {
    const [tx, txEvents] = latestTx;
    log.info("most recent fill-related tx (by MM USDC activity)", {
      tx,
      block: txEvents[0]?.block,
      legs: txEvents.map((e) => ({
        dir: e.dir,
        usdc: e.usdc,
        from: label(e.from),
        to: label(e.to),
        kind: classify(e),
      })),
    });
  }
}

main().catch((err) => {
  log.error("failed", { err: String(err) });
  process.exitCode = 1;
});
