# Convallax Market Maker

Independent market-maker bot for [Convallax](https://docs.convallax.com) — an RFQ
options venue for European calls/puts on Polymarket YES outcomes, settled on
Polygon Amoy testnet (chain `80002`).

We are a fully independent maker: we hold our own wallet keys, quote with our own
wallet address, and sign our own EIP-712 settlement orders. The Convallax backend
is a relay + matching engine and never holds our keys.

- Maker wallet: `0xf8D0dead28cBB8C257E4f2dCf6c89c52b97fc0F3`
- Maker id: `mm_37a2449f4b`

## Architecture (three-channel transport)

| Channel | Transport | Module | Direction |
|---|---|---|---|
| 1. Quote requests | SSE | `src/transport/sse.ts` | server → us |
| 2. Quote submit + confirm | REST | `src/rest/client.ts` | us → server |
| 3. Post-trade (win/loss) | WebSocket | `src/transport/ws.ts` | server → us |

Other modules:

- `src/config.ts` / `src/constants.ts` — env config + protocol constants (addresses, EIP-712 domain).
- `src/types.ts` — wire types for all payloads.
- `src/pricing/math.ts` — exact collateral/premium/no-arb math (protocol-defined; not a model).
- `src/pricing/engine.ts` — **placeholder** pricing engine; the real proprietary model goes here (Phase 4).
- `src/signing/order.ts` — EIP-712 order signing with domain/maker safety checks.
- `src/onchain/usdc.ts` — balances + USDC approvals (Core for collateral, Settlement for premium).
- `src/state/store.ts` — open quote requests + our submitted quote ids.
- `src/scripts/setup.ts` — Phase 0 preflight (status, discovery, balances, approvals, faucet).
- `src/index.ts` — Phase 1 read-only listener.

## Setup

1. Install deps:

   ```bash
   npm install
   ```

   > If your global npm cache has permission issues, this repo was bootstrapped
   > with a project-local cache: `npm install --cache ./.npm-cache`.

2. Configure environment:

   ```bash
   cp .env.example .env
   # then fill in CONVALLAX_API_KEY and MM_PRIVATE_KEY
   ```

   - `CONVALLAX_API_KEY` — generate in the Convallax dashboard (Settings → API Keys). Authorizes quoting only.
   - `MM_PRIVATE_KEY` — the maker wallet key. Needed for approvals/signing, **not** for the read-only listener.

3. Preflight (safe, read-only by default):

   ```bash
   npm run setup            # status + market discovery + balances + allowances
   npm run faucet           # also request 1,000 testnet USDC (24h cooldown)
   npm run approve          # also set USDC approvals on Core + Settlement
   ```

   You also need Amoy POL for gas — fund the wallet from the Polygon Amoy faucet.

## Run locally

The runtime mode depends on whether `MM_PRIVATE_KEY` is set:

- **Read-only** (no key): connects both channels and logs requests/wins, submits nothing.
- **Live** (key set): quotes every request via the placeholder engine and signs+confirms on wins.

```bash
npm run start    # run the maker (live if MM_PRIVATE_KEY set, else read-only)
npm run dev      # same, with auto-reload
npm run typecheck
```

> Before running live, ensure the wallet has Amoy POL + testnet USDC and both USDC
> approvals are set (`npm run approve`). The bot runs an on-chain preflight at
> startup and warns if approvals/balances are missing.

## Run 24/7 (cloud server)

To keep quoting when your laptop is off, run the bot on a small VPS with
**systemd** (auto-restart + survive reboots). Step-by-step instructions for
non-engineers: **[deploy/DEPLOY.md](deploy/DEPLOY.md)**.

## Phase status

- [x] **Phase 0** — setup/discovery, on-chain approvals.
- [x] **Phase 1** — read-only listener (both channels, reconnect, state store).
- [x] **Phase 2** — submit quotes (`Quoter` → `POST /v1/mm/quotes`, stores quoteId).
- [x] **Phase 3** — win → sign EIP-712 → confirm before deadline (`Confirmer`).
- [ ] **Phase 4** — proprietary pricing model (replaces `NaivePlaceholderEngine`).
- [ ] **Phase 5** — risk/capital management (local collateral accounting, limits, kill switch).
- [ ] **Phase 6** — settlement automation (`claimWriterCollateral`).
- Hedging on Polymarket CLOB: **skipped on testnet** (per current scope).

## Key facts (confirmed with the Convallax team)

- Pricing is entirely ours; Convallax-provided `sigmaL`/`currentYesPrice`/`tauDays` are suggestions only.
- No fees currently (testnet).
- The backend builds the order using **the maker's quoted size verbatim** (not the taker's requested size). Collateral/premium are computed from the size we quote.
- No rate limits on maker endpoints today.
- No capital pre-reservation; reverted fills are not penalized.

## Winner selection & validation (from docs)

- Taker buying → lowest valid price wins; taker selling → highest wins.
- Quote must: match side, use a signable maker wallet, size ≥ 50% of requested, price in `(0,1)`, and respect no-arb (`call ≤ 1−K`, `put ≤ K`).
