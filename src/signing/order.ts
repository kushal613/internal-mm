import { ethers, type TypedDataField } from "ethers";
import { ORDER_DOMAIN, ORDER_TYPES } from "../constants.js";
import type { Eip712Domain, OrderStruct } from "../types.js";

/**
 * Sign the EIP-712 Order delivered in `quote:accepted`.
 *
 * Always sign the domain/types/order exactly as received from the server (they are
 * authoritative), but we sanity-check the domain against our known constants so a
 * misconfigured relay or spoofed message can't get us to sign for the wrong chain
 * or contract. The backend verifies the signature recovers to order.maker.
 */
export async function signOrder(
  wallet: ethers.Wallet,
  domain: Eip712Domain,
  types: { Order: TypedDataField[] },
  order: OrderStruct,
): Promise<string> {
  assertDomain(domain);
  assertMaker(wallet, order);
  return wallet.signTypedData(domain, types, order);
}

function assertDomain(domain: Eip712Domain): void {
  const mismatches: string[] = [];
  if (domain.name !== ORDER_DOMAIN.name) mismatches.push(`name=${domain.name}`);
  if (Number(domain.chainId) !== ORDER_DOMAIN.chainId) mismatches.push(`chainId=${domain.chainId}`);
  if (domain.verifyingContract.toLowerCase() !== ORDER_DOMAIN.verifyingContract.toLowerCase()) {
    mismatches.push(`verifyingContract=${domain.verifyingContract}`);
  }
  if (mismatches.length) {
    throw new Error(`Refusing to sign: unexpected EIP-712 domain [${mismatches.join(", ")}]`);
  }
}

function assertMaker(wallet: ethers.Wallet, order: OrderStruct): void {
  if (order.maker.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `Refusing to sign: order.maker (${order.maker}) != wallet (${wallet.address})`,
    );
  }
}

/** Default types as a fallback when a message omits them (it shouldn't). */
export const DEFAULT_ORDER_TYPES = ORDER_TYPES as unknown as { Order: TypedDataField[] };
