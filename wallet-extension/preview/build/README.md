# Marketing HTML Mockups

Static, iframe-embeddable replicas of six chromatika wallet screens, generated from the real wallet React components with mocked I/O. For marketing / docs / landing-page embeds. Animations play; clicks no-op.

## Output

`pnpm run preview:build` produces `wallet-extension/preview-dist/` with:

```
preview-dist/
  onboarding.html       choose-step CTA picker (cycles sui ↔ solana every 6s)
  assets.html           portfolio aggregator with David's two dWallets
  activity.html         David ↔ Toly transaction feed (10 rows, mixed states)
  send.html             chain chip row + recipient/amount form (empty state)
  vault-home.html       WalletPage vault summary with rocket-deck illustration
  dwallets.html         per-rail address chips for David's SECP256K1 dWallet
  assets/               shared chunks (React vendor, wallet css, trpc-mock, etc.)
  …public/ static assets (logo, fonts) copied from wallet-extension/public/
```

Per-iframe gzip totals ~70-135 KB (heaviest is vault-home, which pulls in framer-motion). Vendor chunks share across iframes when served from the same origin, so the second iframe loads from cache.

## Personas

Two demo identities baked into the fixtures:

| | David | Toly |
|---|---|---|
| ika base | sui | solana |
| unlock | passkey | seeker (mwa-remote) |
| sui | `0xdavd…2a3b` | `0xtoly…2a3b` |
| evm | `0xDavd…0a1b` | `0xToLy…0a1b` |
| solana | `DAVDb…N` | `ToLY1…k9` |
| btc segwit | `bc1qdavd…` | `bc1qtoly…` |

David is the active vault on every screen. Toly appears as a counterparty in the activity feed and as a sibling vault in the multi-vault selector.

## How layout changes carry over

Edit any `wallet-extension/src/ui/...` component, rerun `pnpm preview:build`, the emitted HTML picks up the change. The preview entries (`onboarding.tsx`, `assets.tsx`, …) import the real component paths verbatim; vite re-traverses the import graph on each build.

You only need to touch this directory when the wallet introduces:

1. **A new tRPC procedure** the preview screens reach. Add an entry to `fixtures/registry.ts` mapping the procedure path to a fixture value. Without it, the call resolves to `null` (which most components tolerate by falling into their empty state, but some crash on null shape mismatches).
2. **A new `chrome.storage` key the wallet branches on**. The stub Proxy already returns no-op functions for any access, but if a hook reads a specific shape, add it under `chrome-stub.ts`'s real-field augmentation.
3. **A new screen the marketing site wants to feature**. Copy any `*.tsx` + `*.html` pair, add the entry to `vite.preview-build.config.ts` `rollupOptions.input`.

## File layout

```
preview/build/
  vite.preview-build.config.ts   build config: aliases @/lib/trpc, emits to preview-dist/
  README.md                      this file
  chrome-stub.ts                 globalThis.chrome recursive Proxy installer
  trpc-mock.ts                   `@/lib/trpc` alias target; backed by fixture registry
  mount.tsx                      shared createRoot wrapper with debug error boundary
  fixtures/
    personas.ts                  David + Toly addresses, dWallet ids, vault metadata
    balances.ts                  per-vault token balance shapes
    networks.ts                  evm/sui/solana/bitcoin/aptos network registry
    activity.ts                  10 transaction history rows (sent, received, swap, etc.)
    dwallets.ts                  dWallet caps + cross-chain address book + display names
    registry.ts                  procedure path -> fixture value lookup
  onboarding.html / .tsx         choose-step picker entry
  assets.html / .tsx             AssetsPage entry
  activity.html / .tsx           ActivityPage entry
  send.html / .tsx               SendPage entry
  vault-home.html / .tsx         WalletPage entry
  dwallets.html / .tsx           DWalletPortfolioPage entry
```

## Local preview

```bash
# build
pnpm run preview:build

# serve preview-dist on localhost:5174 (uses .claude/launch.json `chromatika-mockups`,
# or run manually:)
npx serve -p 5174 wallet-extension/preview-dist
# open http://localhost:5174/onboarding.html
```

## Embed snippet

```html
<iframe
  src="https://your-host/onboarding.html"
  width="400"
  height="720"
  sandbox="allow-scripts"
  style="border: 0; border-radius: 16px;"
></iframe>
```

`allow-same-origin` is NOT needed - the preview makes no network requests beyond its own bundle.

## CI safety net

`pnpm run preview:build` is wired into `.github/workflows/ci.yml` after the main `Build` step, so PRs that break a screen (new tRPC procedure without a fixture, removed component, fixture shape drift) fail loudly before merge.

## Out of scope

- **Interactivity** - clicks no-op, form fields are empty. Adding interactivity would require driving real state, which contradicts the static-mockup goal.
- **Real chain data** - all balances, addresses, transactions are fixtures. Production wallet talks to chains; the preview never does.
- **Auto-cycling slideshow** - each iframe is one screen. A marketing page that wants a slideshow assembles one in its own runtime.
- **Non-side-panel sizing** - chromatika is built for the chrome side panel (~360-440 px wide). The HTML shells hardcode 400×720 px to match. Different sizes need different fixtures of the layout.
