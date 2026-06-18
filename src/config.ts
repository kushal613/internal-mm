import "dotenv/config";
import { EXPECTED_MAKER_WALLET } from "./constants.js";

/**
 * Runtime configuration loaded from environment.
 *
 * Two distinct secrets (kept separate on purpose):
 *  - apiKey:     authorizes quoting over SSE/REST/WS. Cannot move funds.
 *  - privateKey: signs EIP-712 settlement orders + on-chain txs (approvals, claims).
 *
 * The Phase 1 read-only listener only needs `apiKey`. Approvals/signing need `privateKey`.
 */
export interface Config {
  apiKey: string | undefined;
  privateKey: string | undefined;
  apiBase: string;
  wsBase: string;
  rpcUrl: string;
  expectedMakerWallet: string;
}

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export const config: Config = {
  apiKey: clean(process.env.CONVALLAX_API_KEY),
  privateKey: clean(process.env.MM_PRIVATE_KEY),
  apiBase: clean(process.env.API_BASE) ?? "https://api.convallax.com",
  wsBase: clean(process.env.WS_BASE) ?? "wss://api.convallax.com",
  rpcUrl: clean(process.env.RPC_URL) ?? "https://rpc-amoy.polygon.technology",
  expectedMakerWallet: EXPECTED_MAKER_WALLET,
};

export function requireApiKey(): string {
  if (!config.apiKey) {
    throw new Error(
      "CONVALLAX_API_KEY is not set. Generate one in the Convallax dashboard (Settings -> API Keys) and add it to .env",
    );
  }
  return config.apiKey;
}

export function requirePrivateKey(): string {
  if (!config.privateKey) {
    throw new Error("MM_PRIVATE_KEY is not set. Add the maker wallet private key to .env");
  }
  return config.privateKey;
}
