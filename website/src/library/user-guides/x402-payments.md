# how to use x402 HTTP payments

chromatika intercepts page-level `fetch` calls that get back `HTTP 402 Payment Required` with the `payment-required` header, opens an approval popup, signs a USDC payment on Solana, and lets the page retry with a `payment-signature` header. this implements the x402 v2.0 spec, `exact` scheme on Solana, USDC mint only.

## prerequisites

- a Chromatika vault is unlocked
- the active vault has access to a Solana signer:
  - **ika MPC path** (default): a Solana ED25519 dWallet exists with USDC on the right network
  - **WalletConnect path**: a WC-paired phone wallet (Seeker / Phantom / Solflare) is set as the active Solana signer (`session.solanaWcAccount`)
- the active dapp's page is making fetch calls to a 402-aware endpoint
- USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (mainnet)

## options at a glance

- **caps**: per-counterparty (per host) daily USD cap, plus a global daily USD cap. defaults: $5 per seller, $25 global. cap-breach pre-popup rejection so the user never sees a popup for an over-budget call
- **default cap**: per-counterparty cap to assign to **new** hosts when seen for the first time
- **receipt log**: 200 most recent payments stored in `chromatika_x402_receipts_v1`
- **quality flag**: thumbs-up / thumbs-down on receipts for future allowlist seeding
- **signing path**: ika MPC (default) or WalletConnect (when `session.solanaWcAccount` is set)

## how the fetch interception works

1. `inject.ts` installs `x402-fetch-wrapper.ts` for every page
2. wrapper intercepts `window.fetch`. on a 402 + `payment-required`, the wrapper sends the encoded header to the dispatcher
3. dispatcher (`x402-dispatch.ts`) decodes `PaymentRequirements`, validates (exact + Solana + USDC), runs `wouldExceedCaps` synchronously - if over budget, **rejects pre-signature** so no popup appears
4. if within caps, opens approval popup at `?x402approve=<id>` - the **only** signing path is the approve tier
5. on approval, the right signer runs (ika MPC or WC). dispatcher returns the `payment-signature` header value + receipt id to the wrapper
6. wrapper retries the original fetch with `payment-signature`. server settles, returns 200 with `payment-response` header
7. `x402RecordSettlement` (fire-and-forget) flips the receipt status to `settled` with the on-chain digest

## how to set spending caps

- per-counterparty: `x402SetPerCounterpartyCap` with `host` and `capUsd` (set null to remove the explicit cap; null means "unlimited" if no global cap, otherwise global applies)
- global: `x402SetGlobalCap` with `capUsd` (or null to clear)
- default for new hosts: `x402SetDefaultCap` with `capUsd`

## how to view caps and today's spend

1. call `x402GetCaps`
2. response includes per-counterparty caps, global cap, default-for-new-hosts cap, and today's USD spend per host + global
3. day buckets are local-timezone

## how to view payment receipts

1. call `x402ListReceipts` with optional `limit` (1-200; default returns all 200 cached)
2. response is the receipt list: `{ id, host, amountUsd, status, txHash?, error?, quality, createdAt, ... }`
3. status values: `pending` (signed, not yet settled) → `settled` (with on-chain hash) / `failed` (with error reason) / `rejected` (user canceled)

## how to flag a receipt as good or bad

1. submit `x402SetReceiptQuality` with `id` and `quality: 'good' | 'bad' | null`
2. flags persist on the receipt; future allowlist / blocklist seeding will read them

## how to approve or reject a pending payment

popup runs through the standard pending-request pattern:

1. `getPendingX402Request` with id - returns the requirements (host, amount in USD, destination ATA, scheme)
2. `approvePendingX402` with id - dispatcher signs via the active path (ika MPC or WC), returns the `payment-signature` header to the page
3. `rejectPendingX402` with id and `reason` (default `'user_canceled'`)

## how to manually post a settlement record

usually the page does this for you, but if you need to wire it manually:

1. call `x402RecordSettlement` with `receiptId` and the page's `paymentResponseHeaderB64`
2. flips receipt status from `pending` to `settled` (or `failed` if the response indicates an error)

## notes

- x402 today is **Solana USDC only**, `exact` scheme. extending to other chains / schemes is tracked future
- the bridge methods on the existing dapp port that handle 402 routing without a new transport: `chromatika_x402_handle_402` and `chromatika_x402_record_settlement`
- the WC signing path is the cleanest mitigation against the "402-bridge breach" class - the ed25519 key never leaves the Seeker / phone
- a real Solana facilitator round-trip has not been exercised end-to-end; the wire format is spec-aligned but you should treat early payments as experimental until a stable facilitator (Coinbase CDP / Second State / x402-rs) is integrated
- caps are USD-day local-timezone bucketed; a payment at 11:59 pm and one at 12:00 am can both be allowed even though they're "back-to-back"
