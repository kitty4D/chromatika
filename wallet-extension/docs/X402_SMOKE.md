# x402 facilitator smoke test

> Two layers: a **wire-format check** that runs from a terminal in seconds (`pnpm smoke:x402`), and a **full browser round-trip** that exercises the actual chromatika signer + popup + activity feed.

## Why both?

Chromatika's x402 signer lives in the chrome extension service worker; it can't be invoked from a Node script alone. The wire-format harness catches **upstream protocol drift** (e.g. a facilitator that switched from `payment-required` to `x-payment-required`, or from `solana-devnet` to `solana`); the browser round-trip is the only path that validates the actual signing + broadcast + receipt flow.

## Layer 1: wire-format harness (~5s)

```bash
cd wallet-extension
pnpm smoke:x402                      # default: https://x402.org/protected
pnpm smoke:x402 --url https://your-test-endpoint.example/api/foo
pnpm smoke:x402 --json               # CI-friendly machine-readable output
```

The script:
- GETs the URL
- Asserts HTTP 402 + a `payment-required` (or `x-payment-required` / `x-402-payment-required`) header
- Decodes the base64 JSON body
- Shape-checks against chromatika's expectations (`scheme: 'exact'`, `network: solana[-devnet|-mainnet]`, base58 `payTo` + `asset`, positive `maxAmountRequired`)

Exit 0 = chromatika should be able to handle this endpoint. Exit 1 = wire format diverges, surface the issues + raw header for debugging.

**Default endpoint**: `https://x402.org/protected` (the demo from the x402-foundation reference repo). Stable enough to use as a CI gate; if it goes down, point `--url` at a Coinbase CDP / Second State / x402-rs test endpoint instead.

## Layer 2: full browser round-trip (~3 min, manual)

The actual end-to-end flow that proves chromatika's signer + popup + receipts work against a real facilitator.

### Prereqs

1. chromatika dev build loaded unpacked in chrome (`pnpm run build`, then load `dist/`)
2. Solana ika base vault unlocked, devnet network selected
3. ~$1 of devnet USDC in the wallet (Circle faucet: https://faucet.circle.com/, USDC dropdown, Solana devnet)
4. Daily caps set to a value that covers the test (Settings → Payments → Caps; default `$5/seller, $25 global` covers any single test endpoint cost)

### Run

1. Open a new tab to the protected URL (e.g. `https://x402.org/protected`).
2. Browser receives 402 + `payment-required` header.
3. chromatika's `dapp-interface/x402-fetch-wrapper.ts` content script intercepts the response.
4. Approval popup opens at `index.html?x402approve=<id>` showing decoded amount, seller, resource URL.
5. Click **approve & sign**.
6. chromatika builds + signs the Solana versioned tx via `x402-solana-signer.ts` (ika MPC) or `x402-walletconnect-signer.ts` (if WC paired).
7. The wrapper retries the original fetch with a `payment-signature` header.
8. Server returns 200 + `payment-response` header containing the on-chain settlement digest.
9. chromatika writes a settled receipt to `chromatika_x402_receipts_v1`.

### Verify

- **Receipt visible**: chromatika side panel → tray icon → Payments → "x402 receipts" should show the new row with `status: settled` + a real Solana settlement tx hash.
- **Cap updated**: Payments → Caps section shows today's spend bumped by the paid amount.
- **On-chain confirm**: paste the settlement tx hash into a Solana devnet explorer (https://explorer.solana.com/?cluster=devnet) — should show a USDC SPL transfer from your wallet to the seller's ATA.

### Failure modes worth catching

- **401 / 403 instead of 402** — server-side auth got in the way; switch endpoint.
- **No `payment-required` header** — server sends only a JSON body. Some implementations skip the header; chromatika requires it. File upstream.
- **Wrong `network` value** — chromatika's dispatcher rejects unknown networks; the wire harness flags this.
- **Cap exceeded** — popup never opens; check Settings → Payments → today's spend vs caps.
- **Insufficient devnet USDC** — settlement tx fails; faucet again.
- **WalletConnect-paired** — when `session.solanaWcAccount` is set, signing routes through the WC relay (Seeker / Phantom / Solflare); approve in the phone wallet's Seed Vault, not in chromatika. For pure ika MPC testing, disconnect WC first.

## Public x402 endpoints (current as of 2026-04-30)

| URL | hosted by | network | notes |
|---|---|---|---|
| `https://x402.org/protected` | x402-foundation | solana-devnet | demo endpoint, stable |
| Coinbase CDP facilitator | Coinbase | varies | needs CDP project setup |
| Second State / x402-rs | Second State | varies | check their docs |

Update this table when endpoints rotate.

## Related

- [`PaymentsPage`](../src/ui/pages/PaymentsPage.tsx) — caps + receipts + private-receipts toggle UI
- [`x402-fetch-wrapper.ts`](../src/dapp-interface/x402-fetch-wrapper.ts) — page-side 402 interception
- [`x402-dispatch.ts`](../src/background/x402/x402-dispatch.ts) — popup orchestration + signer routing
- [`x402-solana-signer.ts`](../src/background/x402/x402-solana-signer.ts) — ika MPC signing path
- [`x402-walletconnect-signer.ts`](../src/background/x402/x402-walletconnect-signer.ts) — Seeker / WC phone signing path
- [`scripts/x402-smoke.mjs`](../scripts/x402-smoke.mjs) — the wire-format harness
