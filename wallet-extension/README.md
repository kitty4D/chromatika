# chromatika wallet extension

this is the actual MV3 chrome extension. react + typescript + vite, tRPC over `chrome.runtime.connect`, vault (Argon2id + AES-GCM), `SuiGraphQLClient` as the default sui transport, `@ika.xyz/sdk` for ika dWallet flows. for the product feature tour + the vault setup deep dive (how each setup method derives the dWallet address, fee payer, and ika info), read the [root README](../README.md).

shipped vs gated vs stubbed vs future: see [`docs/STATUS.md`](docs/STATUS.md).

---

## prerequisites

- **Node 20+** (vite 8 + rolldown).
- **pnpm 10.33.0** (pinned in `package.json` `packageManager`). enable corepack so the right pnpm gets activated automatically:
  ```
  corepack enable
  corepack prepare pnpm@10.33.0 --activate
  ```
- **Chromium-based browser** with MV3 + WebHID + side panel + native messaging support. Chrome / Chromium / Edge / Brave (≥ 120) are the tested set.
- **optional hardware** for hardware-vault testing:
  - real Ledger device (any model with the sui app + solana app + ethereum app for full coverage; bitcoin app for BTC PSBT).
  - real Trezor model T (solana + bitcoin PSBT).
  - Android phone (Kiwi / Chromium) or Solana Seeker for MWA flows.

---

## install

```
cd wallet-extension
pnpm install
pnpm exec playwright install chromium   # one time per machine, only if you'll run e2e tests
```

non-obvious bits:

- `postinstall` runs `scripts/postinstall-rm-nested-mysten.mjs` which deletes the nested `@mysten` copy under `@ika.xyz/sdk/node_modules`. without that, two copies of `@mysten/sui` end up in the tree and runtime resolution flips. **don't `--ignore-scripts`.**
- `prepare` runs `scripts/setup-hooks-path.mjs` to wire up git hooks.
- pnpm overrides ship a local `@ledgerhq/live-network` stub (upstream's top-level `require('https')` crashes MV3 service workers) and pin `@types/node` to `^22` (node 25's strict `Buffer` types break ~17 solana / ledger / encrypt sites). both are version-agnostic, no patches to refresh.
- `npm ls @mysten/sui` may exit 1 / show "invalid" because pnpm overrides + npm don't agree. that's a tooling artifact; the runtime tree is fine after the postinstall cleanup.
- for CI, use `pnpm install:frozen` (which is just `pnpm install --frozen-lockfile`).

---

## build + load in chrome

```
pnpm run build
```

emits the production bundle to `dist/` (tsc typecheck + vite build).

then in chrome:

1. open `chrome://extensions`, toggle **developer mode** on.
2. click **load unpacked**, point at `wallet-extension/dist/`.
3. pin the chromatika card to the toolbar if you want fast access.

re-running `pnpm run build` overwrites `dist/`. click **reload** on the chromatika card to pick up the new build; you do **not** need to remove + re-add. MV3 service-worker, popup, and side-panel HTML changes all need that reload.

---

## dev workflow

| command | what it runs |
|---|---|
| `pnpm run dev` | `vite build --watch` - rebuilds `dist/` on change. **recommended for daily work.** does not auto-launch chrome (avoids spawning a new browser every save); manually click "reload" on the chromatika card. |
| `pnpm run dev:launch` | same as `dev` but sets `CHROMATIKA_WEBEXT_LAUNCH=1` so vite-plugin-web-extension spawns a fresh chromium each rebuild. nice for the very first boot; usually too churny for daily use. |
| `pnpm run dev:polling` | `dev` with `CHOKIDAR_USEPOLLING=1` for filesystems where native FS watch is flaky (some Docker / VM / WSL setups). |
| `pnpm run build` | one-shot production build. |
| `pnpm run preview` / `pnpm run preview:ui` / `pnpm run preview:build` | vite preview variants for design / UI work. |
| `pnpm run lint` | eslint over `src/**/*.{ts,tsx}`. |

---

## test

| command | what it runs |
|---|---|
| `pnpm test` | vitest unit tests under `src/**/*.test.ts`. |
| `pnpm run test:fast` | same with `CHROMATIKA_TEST_FAST_KDF=1` to skip the slow Argon2id rounds in tests. use for tight loops, not for vault crypto checks. |
| `pnpm run test:watch` | vitest watch mode. |
| `pnpm run test:e2e` | runs `pnpm run build` then headed playwright against `dist/`. see `e2e/fixtures.ts` for how the unpacked extension gets loaded. |
| `pnpm run test:e2e:ui` | same, playwright UI mode. |

end-to-end specs live under [`e2e/`](e2e/). they require a successful build so `dist/manifest.json` exists.

---

## optional build-time env vars

set in `.env` (or CI env) before `pnpm run build`. vite inlines `import.meta.env.*` at build time, so a rebuild is needed after changing any of these. template at [`.env.example`](.env.example).

| variable | effect |
|---|---|
| `VITE_WC_PROJECT_ID` | WalletConnect project id (register at `cloud.reown.com`). required to surface the WalletConnect option on the hardware setup step. without it, the WC button stays disabled. WalletConnect is the canonical solana hardware path on desktop today. |
| `VITE_ALCHEMY_KEY` | EVM NFT metadata via Alchemy (`services/nft.ts`). without it, EVM collectibles stay empty in the NFT tab. |
| `VITE_HELIUS_KEY` | solana NFT metadata via Helius DAS, plus built-in solana mainnet / devnet JSON-RPC presets for balances + sends. without it, the mainnet preset falls back to Ankr public RPC and devnet uses Solana Labs devnet. |
| `VITE_CMC_API_KEY` | adds CoinMarketCap as a step in the price waterfall after DefiLlama (`services/price.ts`). |
| `VITE_PHASE_B_SUI_SWAP` | Aftermath sui -> IKA swap UI (`features.ts`). default: enabled. set to `false` to turn off. |
| `VITE_SOLANA_IKA_BASE` | show solana as an ika base chain in **production** builds. dev builds always show it. set `true` to enable in prod. dev-mode pre-alpha; do **not** enable on a prod build that users could load real funds into. |
| `VITE_ENABLE_MWA_REMOTE` | re-enable the MWA-remote (Seeker QR pair) hardware option on desktop. default: `false`. Solana Mobile's reflector demo is currently unreliable, so this is hidden by default; flip to `true` after upstream fixes the reflector. WalletConnect (`VITE_WC_PROJECT_ID`) is the canonical desktop solana path in the meantime. |
| `VITE_DEBUG_GRAPHQL` | verbose sui GraphQL logging in the service-worker console (`sui-graphql-debug-fetch.ts`). |
| `VITE_DEBUG_GRAPHQL_OPS` | comma allowlist when debug is on, so the console isn't flooded. example for ika sign polling: `multiGetObjects,getObject,_anon_`. |
| `VITE_DEBUG_GRAPHQL_PAGINATION` | extra GraphQL pagination logging. very noisy. |

privacy / disclosure notes on third-party APIs (Alchemy, Helius, etc.): [`docs/WALLET_SECURITY.md`](docs/WALLET_SECURITY.md).

---

## MCP native host setup (optional)

chromatika ships a chrome native messaging host that exposes its MCP surface to local agents (Claude Desktop, etc.). after you've built + loaded the extension once and grabbed your extension id from `chrome://extensions`:

```
pnpm setup:native-host --extension-id=<your-extension-id>
```

the script registers the host manifest in the OS-specific location (chrome native messaging hosts dir on win / mac / linux). settings -> agents in the wallet UI lets you toggle the listener on / off, reveal / copy / rotate the bearer token, and pin the listen port.

read tier (no popup): `listVaults`, `getActiveVault`, `getActiveNetworks`, `getLockState`. approve tier (popup-gated): `signMessage`, `sendEvmTx`, `signTransaction`. see the root README "MCP agent surface" section for details.

---

## policy contract deploy (optional)

**sui Move (`wallet-extension/move/chromatika-policy`):**

```
pnpm build:sui-policy
pnpm test:sui-policy
pnpm deploy:sui-policy:testnet     # or :mainnet, :devnet, :dry-run
```

**solana anchor (pre-alpha; `wallet-extension/solana/chromatika-policy`):**

```
pnpm build:solana-policy
pnpm test:solana-policy
pnpm deploy:solana-policy:devnet   # or :dry-run
```

the deploy scripts wrap the underlying `sui move build` + `sui client publish` (sui) and `anchor build` + `anchor deploy` (solana), auto-extract the published package id / program id, and update local config. full runbook (CLI install, funding, flags, failure modes): [`docs/POLICY_DEPLOY_QUICKSTART.md`](docs/POLICY_DEPLOY_QUICKSTART.md).

---

## mobile / Seeker testing

chromatika supports two transports for solana hardware-wallet onboarding via the Mobile Wallet Adapter:

- **local (Android Chromium)** - load chromatika on an Android phone (Kiwi or any Chromium variant), pick **Solana Mobile (this phone)** in the hardware step. pairing fires an Android intent (`solana-wallet://`) so the wallet app on the same device handles signing. UA gate: only shown on Android.
- **remote (desktop ↔ Solana Seeker / phone)** - load chromatika on desktop chromium, pick **Seeker (QR pair)**. pairing opens a wss session to `${mwaReflectorHost}/reflect`, renders an association URL as a QR; scan with the Seeker (or any MWA-compliant phone wallet) and approve in Seed Vault. the persisted `auth_token` lets every subsequent sign reauthorize without rescanning the QR. UA gate: only shown on non-Android. **off by default in prod builds** (see `VITE_ENABLE_MWA_REMOTE` above).

both transports use a deterministic in-extension solana fee-payer keypair (`solanaFeeKeypairFromWalletSignature(signature, 1)`) so SOL persists across reinstalls when you re-pair the same Seeker. fund the fee-payer address with ~0.1 devnet SOL after the first vault create.

solana ika base is **devnet pre-alpha** behind `VITE_SOLANA_IKA_BASE=true` and uses **mock MPC signing**. do **not** sign real-value transactions on this stack.

full runbook (pairing, auto-seed solana fee keypair, troubleshooting): [`docs/SEEKER_REMOTE_PAIRING.md`](docs/SEEKER_REMOTE_PAIRING.md).

---

## known dev caveats

- background bundle is large (~5.5 MB, ~1.6 MB gzip). ika + ika WASM + crypto libs dominate. cold first load takes a moment.
- `solana-base` ika is dev-mode mock signing only, behind `VITE_SOLANA_IKA_BASE=true`. don't ship a build for end users with that flag on until ika alpha 1.
- some sui dapps that expect Mysten-native BLAKE2b `signPersonalMessage` may reject ika's SHA512 path. tracked in [`docs/WALLET_SECURITY.md`](docs/WALLET_SECURITY.md).
- WebHID is only available in popup / side panel (user-gesture context), never in the MV3 service worker. ledger signing opens `index.html?hwsign=ID` popup; `TransportWebHID.create()` runs there.
- `Connection.confirmTransaction` from `@solana/web3.js` 1.x opens a websocket subscription that references `window`, which doesn't exist in the SW. all confirm sites route through `confirmSolanaTxByPolling` instead (HTTP-only polling). don't add new direct calls to `confirmTransaction` in the SW.

---

## architecture (section 1, locked)

authoritative diagram: [`docs/architecture-final.html`](docs/architecture-final.html). prose summary below matches that document.

### UI

- **side panel** = primary UI; **popup** = quick actions.
- surfaces: accounts · send / receive · activity · NFT gallery · kiosks · IKA staking · dApps · settings · advanced · network selector.
- NFT rendering + sui kiosk respect **MediaSafetyMode**.
- networks: built-in (common chains + L2s + testnets) + custom entries; registry shape follows the Trust Wallet `registry.json` schema mindset.
- price quotes: priority order user-configurable under settings -> advanced.

### UI ↔ background

- **tRPC** over `chrome.runtime.connect` (port) with `sendMessage` fallback. 12s response timeout on procedures that aren't long-running approvals or swap so a cold MV3 SW can't leave the UI hanging on a silent port (`src/lib/trpc.ts`).

### background service worker

| area | notes |
|---|---|
| **vault** | Argon2id (RFC 9106 t=3, m=64 MiB, p=4) + AES-GCM 256. non-extractable `CryptoKey` in session memory; bytes never written to `chrome.storage.local`. session-scoped unlock cache only (`chromatika_unlock_cache_v1` in `chrome.storage.session`). |
| **keyring** | BIP39 / BIP44 (sui SLIP10 ed25519, solana SLIP10 ed25519) + ika DKG. |
| **presign pool** | three pools: `SECP256K1_ECDSA`, `SECP256K1_TAPROOT`, `ED25519_EDDSA`. auto-replenished every 5 min via `chrome.alarms` (`chromatika-presign-refill`). per-vault storage key `chromatika_presign_pools_v3_<vaultId>`. solana-base ika never pools `ED25519_EDDSA` (RFC 8032 deterministic + pre-alpha gRPC restriction); SECP256K1 still pools. |
| **IkaAdapter** | `getIkaAdapter(session, baseChain)` -> `SuiIkaAdapter` (IkaClient + PTBs over GraphQL) or `SolanaIkaAdapter` (pre-alpha devnet + gRPC). signing code never calls `session.ikaClient.*` directly. |
| **hardware** | Ledger via WebHID (popup / side panel only). Trezor via `@trezor/connect-web`. MWA local (Android intent) + remote (wss reflector + QR). WalletConnect v2 (Solana relay session). |
| **chain clients** | EVM: ethers v6. BTC: bitcoinjs-lib (segwit + taproot). solana: `@solana/web3.js` 1.x with HTTP-polling confirms. sui: `@mysten/sui` 2.16.x, GraphQL only (`SuiGraphQLClient`). aptos: `@aptos-labs/ts-sdk`. |

### network registry

- **built-in:** ETH (coinType 60), BTC (0), SOL (501), SUI (784), APT (637), major L2s (Base, Arbitrum, Optimism, Polygon, Monad, ...), SOL / SUI / APT testnets, BTC Signet.
- **custom:** manual entry per chain type. EVM: chainId, name, RPC, symbol, explorer. SOL / SUI / APT: name + RPC. BTC: name + Esplora URL. EVM quick-add via chainlist.org search.

### data services

- **PriceService:** user-ordered waterfall under settings -> USD price sources. shipped order: CoinGecko -> DefiLlama -> CoinMarketCap (optional) -> Pyth -> Chainlink (subset) -> GeckoTerminal DEX TWAP (for IKA). 60s session cache. BTC fiat off-chain only.
- **NFTService:** EVM (Alchemy, Moralis fallback), solana (Helius DAS), sui (on-chain Display + `@mysten/kiosk`), aptos (indexer), BTC (Hiro Ordinals). respects MediaSafetyMode.
- **SuiKioskService:** `@mysten/kiosk` SDK. owned + managed kiosks, listings, transfer policies, royalties.

### MediaSafetyMode

- `all` - any image URI.
- `ipfs / arweave` - **default**, hijack-safer loading.
- `none` - no remote images.

offscreen media cache is an architectural target only; no `chrome.offscreen` document yet, no `offscreen` manifest permission requested.

### content script + injection

- content script runs `all_frames`, injects the dapp-interface into the page (main world).
- bridge: `chrome.runtime.sendMessage` with origin + `event.source` validated.
- providers: EIP-1193 + EIP-6963 + EIP-3085 + EIP-3326 (EVM), `window.bitcoin`, `window.aptos`, Wallet Standard for sui ("Chromatika Sui") and solana ("Chromatika Solana").
- per-origin permissions store (`chromatika_dapp_permissions_v1`); strict consent gates sign methods per origin.
- compat note: `sui_signPersonalMessage` uses ika SHA512, not Mysten-native BLAKE2b. some dapps may reject until alignment lands.

### popup / side panel sync

- **SharedWorker** at [`src/shared/wallet-state-worker.ts`](src/shared/wallet-state-worker.ts) relays events between popup + side panel ports when both are open. graceful fallback if SharedWorker isn't available.
- **operation-progress banner**: long-running flows (ika sign, presign refill, slow solana confirms) write a single-slot status to `chrome.storage.session` under `chromatika_op_progress_v1`. all UI surfaces subscribe via `chrome.storage.onChanged` (a real cross-context push). recovery actions attach for known failure modes (e.g. devnet-wipe -> "recreate ED25519 dWallet").

---

## sui connectivity (important)

**GraphQL only.** chromatika doesn't talk Mysten JSON-RPC at all (per [`src/config/sui.ts`](src/config/sui.ts) + the `ikaTransportDebug` log line in [`src/server/routers/vault.ts`](src/server/routers/vault.ts)). NFT + kiosk + activity + SuiNS + IkaClient all ride a single per-network `SuiGraphQLClient`.

if a future surface needs a sui read GraphQL doesn't yet expose, hand-roll a query via `client.query` (see `queryTransactionBlocksGraphQL` at `src/background/sui-client.ts:306` for the pattern). don't reach for `SuiJsonRpcClient`.

**chunking wrapper:** at `new SuiGraphQLClient(...)` we install a runtime wrapper around `client.core.getObjects` that chunks 12 ids per POST (default is 50) with 100 ms between chunks, keeping the body under the GraphQL server's ~5000 B limit. see `installGetObjectsChunking` in `src/background/sui-client.ts`. this replaced an old pnpm patch on `@mysten/sui` so package upgrades don't need patch refreshes.

---

## key files

| path | role |
|---|---|
| `src/background/session.ts` | session state type (`SessionState`, `DWalletMeta`, `BaseChain`); `getSession()` / `isUnlocked()` |
| `src/background/vault.ts` | AES-GCM vault, Argon2id key derivation |
| `src/background/lock-manager.ts` | auto-lock alarm, `chrome.alarms` wiring |
| `src/background/index.ts` | service worker entry: tRPC handler, dapp bridge, phishing dNR sync, presign alarm |
| `src/background/wallet-service.ts` | unlock / lock / create / import / add / switch vault, session bootstrap |
| `src/background/vault-types.ts` | `VaultRecord` discriminated union (HD / importedKey / hardware / passkey / waap / lazor / dwalletAnchored) |
| `src/background/keyring/hd.ts` | BIP39 / BIP44, ika seed derivation: `ikaRootSeedFromFeeKeypair`, `ikaRootSeedFromSolanaKeypair`, `ikaRootSeedFromMwaSignature`, `ikaRootSeedFromPasskeyPRF`, `ikaRootSeedFromRecoveryWords`, `solanaFeeKeypairFromWalletSignature` |
| `src/background/ika/ika-adapter.ts` | `IkaAdapter` interface, `SuiIkaAdapter` (live), `SolanaIkaAdapter` (pre-alpha), `getIkaAdapter()` |
| `src/background/ika/dwallet-lifecycle.ts` | DKG, `acceptEncryptedUserShare`, dWallet state management |
| `src/background/ika/presign-pool.ts` | three presign pools, `replenishPool`, `takePresign`, `takePresignId` |
| `src/background/ika/pricing.ts` | `getRequiredCoinAmounts(ikaClient)` reads on-chain pricing map; never hardcode coin split amounts |
| `src/background/chains/signing.ts` | all MPC signing: `signBytesEvm`, `signMessageBtc`, `signMessageSol`, all via IkaAdapter |
| `src/background/chains/evm-send.ts` | `signAndBroadcastEvm`, `completeTxParams`, `getRpcProvider` |
| `src/background/chains/evm.ts` | `getEvmAddress()` from SECP256K1 dWallet pubkey |
| `src/background/chains/bitcoin.ts` | `getDwalletSecpPublicKey`, BTC address derivation, `bitcoinMessageBytes` |
| `src/background/chains/solana.ts` | `getDwalletEd25519PublicKey`, `getSolanaAddress()` |
| `src/background/chains/solana-confirm.ts` | `confirmSolanaTxByPolling` (HTTP-only; never call `Connection.confirmTransaction` in the SW) |
| `src/background/chains/aptos.ts` | aptos address + signing |
| `src/background/dapp-bridge.ts` | dapp method routing: EVM (EIP-1193 / 3085 / 3326), solana (`solana_*`), sui (`sui_*`), aptos, EVM RPC proxy |
| `src/background/tx-decode.ts` | 36-entry 4-byte selector map; `decodeTx()` produces human-readable summary + warnings |
| `src/background/tx-approval.ts` | dapp tx approval queue: `enqueueTxApproval`, popup open, 5-min auto-reject |
| `src/background/dapp-permissions.ts` | `checkPermission`, `grantPermission`, `revokePermission`, `getAllPermissions` |
| `src/background/network/active-network.ts` | `getActiveNetworks` / `setActiveNetworks`; storage key `chromatika_active_networks_v1` |
| `src/background/network/custom-networks.ts` | CRUD for user-added networks; `chromatika_custom_networks_v1` |
| `src/background/ika-base-mode.ts` | global ika base chain UI preference (sui / solana, default sui); `chromatika_ika_base_mode_v1` |
| `src/background/network/chainlist.ts` | `searchChainlist(query)`: live fetch from chainid.network, skips API-key RPC templates |
| `src/background/services/price.ts` | PriceService waterfall (user order from settings); 60s cache |
| `src/background/services/nft.ts` | multi-chain NFT fetch (sui via GraphQL, BTC Hiro, EVM Alchemy, solana Helius) |
| `src/background/services/sui-kiosk.ts` | `@mysten/kiosk` wrapper |
| `src/background/services/media-safety.ts` | `MediaSafetyMode`, `filterImageUrl`, IPFS / Arweave detection |
| `src/background/hardware/` | `types.ts`, `pending-queue.ts` (sign queue, opens popup), `accounts.ts` (storage), `mwa-remote.ts` (wss reflector + QR pair) |
| `src/background/identity.ts` | `resolveCanonicalSuiReceiveAddress`: ED25519 dWallet sui address when active, else fee payer |
| `src/background/phishing.ts` | `eth-phishing-detect` wrapper; dNR rules wired in `index.ts` |
| `src/background/progress/operation-progress.ts` | single-slot status record in `chrome.storage.session`; cross-context push via `storage.onChanged` |
| `src/background/sui-client.ts` | `SuiGraphQLClient` setup + `installGetObjectsChunking` (12-id chunks, 100ms gap) |
| `src/config/networks.ts` | full built-in network registry + `EvmNetwork` / `SolanaNetwork` / etc. types; `findEvmNetwork` |
| `src/config/sui.ts` | sui network endpoints (GraphQL only) |
| `src/server/router.ts` + `src/server/routers/` | all tRPC procedures |
| `src/content-script/index.ts` | relays push events to page, forwards dapp requests to background |
| `src/dapp-interface/inject.ts` | `window.ethereum`, `window.solana`, `window.sui`, `window.aptos`, `window.bitcoin` shims; EIP-6963 |
| `src/dapp-interface/wallet-standard-register.ts` | Wallet Standard registration (sui + solana Chromatika wallets) |
| `src/dapp-interface/x402-fetch-wrapper.ts` | x402 HTTP 402 + payment-required interception |
| `src/shared/wallet-state-worker.ts` | SharedWorker broadcast bus: relays messages across popup + side panel ports |
| `src/lib/use-shared-bus.ts` | `useSharedBus(onMessage?)` hook with graceful fallback |
| `src/ui/SidePanelApp.tsx` | full side panel UI: 5-tab nav, send page, NFT gallery, settings + network selector + dApps |
| `src/ui/App.tsx` | popup UI: unlock, approve-tx, ledger-connect, ledger-signer screens |
| `src/ui/wallet.css` | `sp-*` design system (CSS custom properties, all side panel components) |
| `e2e/` | Playwright e2e: headed Chromium, loads `dist/` as unpacked MV3 extension |
| `public/phishing-warning.html` | dNR redirect target: shows blocked domain, go-back / ignore buttons |
| `native-host/chromatika-mcp-host.mjs` | chrome native messaging MCP host (HTTP + stdio modes) |
| `move/chromatika-policy/` | sui Move policy package |
| `solana/chromatika-policy/` | solana anchor policy program (pre-alpha) |
| `stubs/ledger-live-network/` | local stub for `@ledgerhq/live-network` (upstream's `require('https')` crashes MV3) |
| `docs/STATUS.md` | shipped vs gated vs stubbed vs future index |
| `docs/TERMINOLOGY.md` | canonical product terms (dWallet vault, dWallet, chromatika vault, ika base chain) |
| `docs/DWALLET_VAULT_MODEL.md` | target multi-vault model + phased epic |
| `docs/WALLET_SECURITY.md` | security disclosures + third-party API privacy notes |
| `docs/SEEKER_REMOTE_PAIRING.md` | MWA remote pairing runbook |
| `docs/POLICY_DEPLOY_QUICKSTART.md` | sui Move + solana anchor policy deploy runbook |
| `docs/architecture-final.html` | locked visual diagram |
| `docs/future/` | roadmap + research (archived zkLogin notes, funding strategy, ika explorer brief) |

---

## license

chromatika is licensed under a source-available license modeled on the Business Source License 1.1 (BUSL 1.1). full text at the repo root: [`../LICENSE`](../LICENSE).

pre-release, as is, no warranty, no liability. tl;dr in the [root README](../README.md).
