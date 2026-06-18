/**
 * Wire types for the Convallax maker transport.
 * Mirrors the documented SSE / REST / WebSocket payloads.
 */

export type OptionType = "call" | "put";
export type Side = "buy" | "sell";

/** `params.market` inside a quote_request. */
export interface QuoteRequestMarket {
  conditionId: string;
  yesTokenId: string;
  question: string;
}

/**
 * `params.option` inside a quote_request. Only optionType/strikeBps/expiryMs are
 * guaranteed; the rest are optional pricing *suggestions* the relay may include.
 */
export interface QuoteRequestOption {
  optionType: OptionType | 0 | 1;
  strikeBps: number;
  expiryMs: number;
  /** Same expiry as `expiryMs`, as an ISO 8601 string. */
  expiry?: string;
  tauDays?: number;
  sigmaL?: number;
  currentYesPrice?: number;
  isResolutionExpiry?: boolean;
}

/**
 * `params.trade` inside a quote_request.
 * - Buys carry `budgetUsd` (a USDC budget); the fill is floor(budgetUsd/price) capped by quoted size.
 * - Sells carry `size` (a contract count).
 */
export interface QuoteRequestTrade {
  side: Side;
  size?: number;
  budgetUsd?: number;
}

export interface QuoteRequestParams {
  wallet: string | null;
  market: QuoteRequestMarket;
  option: QuoteRequestOption;
  trade: QuoteRequestTrade;
}

/** Full SSE `quote_request` event payload. */
export interface QuoteRequestEvent {
  requestId: string;
  expiresAt: string;
  params: QuoteRequestParams;
}

/** Body of POST /v1/mm/quotes -> quote field. */
export interface QuoteSubmission {
  maker: string;
  side: Side;
  price: number;
  size: number;
  fairValue?: number;
  spread_bps?: number;
  greeks?: Partial<Record<"delta" | "gamma" | "theta" | "vega", number>>;
  expires_in_ms?: number;
}

export interface SubmitQuoteResponse {
  success: boolean;
  quoteId?: string;
  error?: string;
}

/** The EIP-712 order struct delivered in `quote:accepted` and signed by the maker. */
export interface OrderStruct {
  maker: string;
  seriesId: string;
  optionAmount: string;
  premiumAmount: string;
  makerSelling: boolean;
  taker: string;
  validUntil: number;
  nonce: number;
}

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

export interface Eip712TypeField {
  name: string;
  type: string;
}

/** Post-trade WebSocket messages (protocol v3). */
export interface WsConnectedMessage {
  type: "connected";
  protocolVersion: number;
  makerId: string;
  authenticated: boolean;
  serverTime: string;
}

export interface WsQuoteAcceptedMessage {
  type: "quote:accepted";
  quoteId: string;
  requestId: string;
  order: OrderStruct;
  domain: Eip712Domain;
  types: { Order: Eip712TypeField[] };
  confirmationDeadline: string;
}

export interface WsQuoteConfirmedMessage {
  type: "quote:confirmed";
  requestId: string;
  quoteId: string;
}

export interface WsQuoteRejectedMessage {
  type: "quote:rejected";
  requestId: string;
  quoteId: string;
  reason: string;
}

export interface WsPongMessage {
  type: "pong";
  timestamp: string;
}

export type WsMessage =
  | WsConnectedMessage
  | WsQuoteAcceptedMessage
  | WsQuoteConfirmedMessage
  | WsQuoteRejectedMessage
  | WsPongMessage;

/** GET /maker/v1/status */
export interface RelayStatus {
  protocolVersion: number;
  makersConnected: number;
  socketsConnected: number;
  streamPath: string;
  quotePath: string;
  wsPath: string;
}

/** GET /v1/markets */
export interface MarketInfo {
  name: string;
  conditionId: string;
  yesClobTokenId: string;
  seriesCount: number;
  strikes: number[];
  expiries: number[];
  optionTypes: OptionType[];
}

export interface MarketsListResponse {
  success: boolean;
  count: number;
  markets: MarketInfo[];
}

/** GET /v1/series */
export interface SeriesInfo {
  seriesId: string;
  conditionId: string;
  yesClobTokenId: string;
  strikeBps: number;
  expiry: number;
  optionType: OptionType;
  settled: boolean;
  resolutionBps: number | null;
}

export interface SeriesListResponse {
  success: boolean;
  count: number;
  series: SeriesInfo[];
}

export interface SeriesFilter {
  conditionId?: string;
  optionType?: OptionType;
  settled?: boolean;
}

/** Helper: normalize optionType (may arrive as 0/1 or "call"/"put"). */
export function normalizeOptionType(t: OptionType | 0 | 1): OptionType {
  if (t === 0) return "call";
  if (t === 1) return "put";
  return t;
}
