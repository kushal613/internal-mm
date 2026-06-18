import { ethers } from "ethers";
import { CONTRACTS, ONE_UNIT } from "../constants.js";
import { createLogger } from "../logger.js";
import { getProvider, getWallet } from "../onchain/usdc.js";
import { formatUnits6 } from "../pricing/math.js";

const log = createLogger("mint");

/**
 * Mint mock testnet USDC directly from the deployed contract (selector 40c10f19,
 * `mint(address,uint256)`). Far faster than the rate-limited faucet.
 *
 *   npm run mint              -> mint 10,000 USDC to the maker wallet
 *   npm run mint -- 25000     -> mint a custom whole-USDC amount
 *   npm run mint -- 5000 0x.. -> mint to a specific recipient
 */
const MINT_ABI = [
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
] as const;

async function main(): Promise<void> {
  const [amountArg, toArg] = process.argv.slice(2);
  const wholeUsdc = amountArg ? Number(amountArg) : 10_000;
  if (!Number.isFinite(wholeUsdc) || wholeUsdc <= 0) {
    throw new Error(`Invalid amount: ${amountArg}`);
  }

  const wallet = getWallet(getProvider());
  const to = toArg ?? wallet.address;
  const amountRaw = BigInt(Math.round(wholeUsdc * Number(ONE_UNIT)));

  const usdc = new ethers.Contract(CONTRACTS.usdc, MINT_ABI, wallet);
  const before = (await usdc.balanceOf!(to)) as bigint;

  log.info("minting mock USDC", { to, amount: wholeUsdc, contract: CONTRACTS.usdc });
  const tx = await usdc.mint!(to, amountRaw);
  log.info("tx sent; waiting for confirmation", { hash: tx.hash });
  await tx.wait();

  const after = (await usdc.balanceOf!(to)) as bigint;
  log.info("mint complete", {
    to,
    before: formatUnits6(before),
    after: formatUnits6(after),
    minted: formatUnits6(after - before),
  });
}

main().catch((err) => {
  log.error("mint failed", { err: String(err) });
  log.error(
    "if this reverted, the mock USDC may restrict minting (e.g. onlyOwner) — share the mint signature/access and I'll adjust",
  );
  process.exitCode = 1;
});
