# chromatika seeker architecture

high-level map of the moving parts. mirrors the plan in [`../README.md`](../README.md) but stays focused on what code lives where and why.

## layers

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ compose UI (xyz.chromatika.seeker.ui.*)                                       │
│   - 18 screens 1:1 with wallet-extension/src/ui/pages/ (phased per plan)      │
│   - bottom nav: wallet · send · activity · nfts · settings                    │
│   - operation-progress banner reads a single-slot datastore record             │
└────────────────┬────────────────────────────────────────┬────────────────────┘
                 │                                        │
                 ▼                                        ▼
┌─────────────────────────────┐         ┌──────────────────────────────────────┐
│ kotlin chain clients         │         │ kotlin ika bridge (xyz.…ika)         │
│ (xyz.…chains.*)              │         │   - hosts a webview in a foreground   │
│   solana: web3-solana +      │         │     service                           │
│           rpc-core           │         │   - posts JSON-RPC to ika-js bundle  │
│   evm:    web3j              │         │   - awaits via evaluateJavascript     │
│   btc:    bitcoinj           │         └────────────────┬─────────────────────┘
│   aptos:  REST               │                          │
│   deso:   REST               │                          ▼
└──────────────┬───────────────┘         ┌──────────────────────────────────────┐
               │                          │ ika-js webview bundle (assets/)      │
               │                          │   - @ika.xyz/sdk (sui base)          │
               │                          │   - @ika.xyz/pre-alpha-solana-client │
               │                          │     (solana base, pre-alpha mock)    │
               │                          │   - @mysten/sui PTB builders         │
               │                          │   - keccak256 + ed25519 via @noble    │
               │                          └──────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ identity + vault (xyz.…identity, xyz.…vault)                                  │
│   - SeedVaultIdentity interface (seed vault sdk binding lands phase 1)        │
│   - ikaRootSeedFromMwaSignature ← byte-parity with hd.ts:131                  │
│   - solanaFeeKeypairFromWalletSignature ← byte-parity with hd.ts:154           │
│   - argon2id (argon2kt) + AES-256-GCM (javax.crypto)                         │
│   - datastore-proto + android keystore for unlock cache                       │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│ dapp surface (xyz.…dapp)                                                      │
│   - MWA walletlib server: solana-wallet:// intent filter, signTx / signMsg    │
│   - WC v2 endpoint for desktop dapp pair                                      │
│   - in-app dapp browser: webview + EIP-1193 / Wallet Standard shims           │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│ background workers (xyz.…service)                                             │
│   - ForegroundSigningService hosts the ika webview                            │
│   - PresignRefillWorker (workmanager, 5 min)                                  │
│   - PhishingRefreshWorker (workmanager, daily)                                │
│   - AlertsPollWorker (workmanager, 5 min) + notification channel              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## what ports verbatim vs what changes

verbatim (just translate the syntax):

- `IKA_USK_DOMAIN`, `IKA_USK_DERIVATION_MESSAGE`, `IKA_FEE_PAYER_DERIVATION_INDEX`.
- `ikaRootSeedFromMwaSignature` and `solanaFeeKeypairFromWalletSignature`.
- argon2id parameters (RFC 9106 §4 second option: t=3, m=64 MiB, p=4).
- `chromatika_vault_v3` JSON envelope shape.
- registry.json schema for built-in + custom networks.

reshaped:

- `chrome.runtime.connect` tRPC → kotlin repository + flow.
- `chrome.storage.local` → datastore-proto.
- `chrome.alarms` → workmanager + periodic workers.
- mv3 service worker → foreground service that owns the ika webview.
- `chrome.declarativeNetRequest` phishing block → block at dapp-connect time in the MWA / WC dispatcher (android can't intercept arbitrary domains).
- `chrome.runtime.connectNative` MCP host → ktor server bound to 127.0.0.1.
- offscreen document for media cache → coil disk cache + URL filter for MediaSafetyMode.

JS bridge owns these (because the SDK is JS-only and reimplementing it in kotlin is multi-month work we are explicitly NOT doing per the plan):

- ika DKG / presign / sign / re-encrypt for both sui base and solana base.
- @mysten/sui PTB construction + execution.
- @mysten/kiosk reads.
- encrypt.xyz CreateInput / ReadCiphertext gRPC.
- WalletConnect v2 sign client (if we go that route for desktop pair).

native kotlin owns:

- solana sol + spl sends via seed vault for mainnet, ika gRPC for devnet pre-alpha paths.
- EVM RPC reads + gas estimation + ledger USB OTG (phase 8).
- bitcoin segwit / taproot tx via bitcoinj.
- aptos + deso REST calls.
- the MWA wallet-side intent handler.
- localhost MCP server + bearer token rotation.
- UI, storage, services, work managers, notifications.

## the identity kernel guarantee

the single most important file is [`identity/IkaSeedDerivation.kt`](../app/src/main/java/xyz/chromatika/seeker/identity/IkaSeedDerivation.kt). it ports two extension functions byte-for-byte, asserts their invariants in unit tests, and pins the version-tagged domain constant against drift.

if those tests pass:

1. **same seeker + same domain → same signature** (RFC 8032).
2. **same signature + same keccak preimage → same root seed**.
3. **same root seed + same curve → same `UserShareEncryptionKeys`** (per `@ika.xyz/sdk@0.4.0`'s curve-byte-aware hash; see [`../CLAUDE.md`](../CLAUDE.md) ika USK derivation note).
4. **same `UserShareEncryptionKeys` + same protocol → same dWallet ID** (the solana-base PDA derives from the pubkey alone; the sui-base dWallet object id is anchored to the encryption key public).

→ a user who signs into the seeker app with the same seed vault as their extension installs sees the same dWallets and can produce the same signatures. no recovery phrase exchange, no vault blob migration.

phase 2 of the plan will exercise this end-to-end by initializing the ika-js bundle with the kotlin-derived `rootSeedB64` and asserting the resulting dWallet id matches a known fixture from the extension.
