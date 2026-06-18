/**
 * Static protocol constants for Convallax on Polygon Amoy testnet (chain 80002).
 * Source: https://docs.convallax.com (testnet guide, lifecycle, settlement).
 */

export const CHAIN_ID = 80002 as const;

/** Our maker identity, as registered on the Convallax dashboard. */
export const EXPECTED_MAKER_WALLET =
  "0xf8D0dead28cBB8C257E4f2dCf6c89c52b97fc0F3" as const;
export const MAKER_ID = "mm_37a2449f4b" as const;

/** Deployed contract addresses on Polygon Amoy. */
export const CONTRACTS = {
  core: "0x5bcE81D59b755628700D94166FE98cb17014dE3f",
  optionToken: "0x829b67148Aa07c4B3EE275Ce24ddb74CDeF671Bb",
  settlement: "0x721C428fb5a5468698C295dD4DC2D7bE06479f21",
  usdc: "0x3e21ecaeeb968eeD34690a93Bbb92032ffe5CF9e",
} as const;

/** REST + streaming paths (relative to API_BASE / WS_BASE). */
export const PATHS = {
  status: "/maker/v1/status",
  markets: "/v1/markets",
  series: "/v1/series",
  faucet: "/faucet",
  quoteRequestStream: "/v1/mm/quote-requests/stream",
  submitQuote: "/v1/mm/quotes",
  confirmQuote: (quoteId: string) => `/v1/mm/quotes/${quoteId}/confirm`,
  makerWs: "/maker/v1/ws",
} as const;

/**
 * EIP-712 domain for the order a maker signs at settlement (ConvallaxRFQSettlement).
 * The `quote:accepted` message also carries domain/types; prefer those at runtime
 * and use this as a sanity check.
 */
export const ORDER_DOMAIN = {
  name: "ConvallaxRFQSettlement",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: CONTRACTS.settlement,
} as const;

export const ORDER_TYPES = {
  Order: [
    { name: "maker", type: "address" },
    { name: "seriesId", type: "uint256" },
    { name: "optionAmount", type: "uint256" },
    { name: "premiumAmount", type: "uint256" },
    { name: "makerSelling", type: "bool" },
    { name: "taker", type: "address" },
    { name: "validUntil", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** USDC and option tokens both use 6 decimals. */
export const TOKEN_DECIMALS = 6 as const;
export const ONE_UNIT = 1_000_000n; // 1 whole option / 1.00 USDC in raw units
