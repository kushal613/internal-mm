import { ethers } from "ethers";
import { config, requirePrivateKey } from "../config.js";
import { CONTRACTS, ONE_UNIT } from "../constants.js";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

/** Effectively-unlimited approval. */
export const MAX_UINT256 = (1n << 256n) - 1n;

export function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });
}

export function getWallet(provider?: ethers.Provider): ethers.Wallet {
  return new ethers.Wallet(requirePrivateKey(), provider ?? getProvider());
}

export function usdcContract(runner: ethers.ContractRunner): ethers.Contract {
  return new ethers.Contract(CONTRACTS.usdc, ERC20_ABI, runner);
}

export interface OnchainStatus {
  wallet: string;
  pol: bigint;
  usdc: bigint;
  allowanceCore: bigint;
  allowanceSettlement: bigint;
}

export async function readOnchainStatus(wallet: ethers.Wallet): Promise<OnchainStatus> {
  const provider = wallet.provider!;
  const usdc = usdcContract(provider);
  const [pol, bal, allowCore, allowSettle] = await Promise.all([
    provider.getBalance(wallet.address),
    usdc.balanceOf!(wallet.address) as Promise<bigint>,
    usdc.allowance!(wallet.address, CONTRACTS.core) as Promise<bigint>,
    usdc.allowance!(wallet.address, CONTRACTS.settlement) as Promise<bigint>,
  ]);
  return {
    wallet: wallet.address,
    pol,
    usdc: bal,
    allowanceCore: allowCore,
    allowanceSettlement: allowSettle,
  };
}

/** Approve a spender for USDC if current allowance is below `minRaw`. Returns tx hash or null. */
export async function ensureApproval(
  wallet: ethers.Wallet,
  spender: string,
  amountRaw: bigint,
  minRaw: bigint,
): Promise<string | null> {
  const usdc = usdcContract(wallet);
  const current = (await usdc.allowance!(wallet.address, spender)) as bigint;
  if (current >= minRaw) return null;
  const tx = await usdc.approve!(spender, amountRaw);
  await tx.wait();
  return tx.hash;
}

/** Threshold below which we consider an approval "not set" (1,000 USDC). */
export const APPROVAL_MIN_RAW = 1_000n * ONE_UNIT;
