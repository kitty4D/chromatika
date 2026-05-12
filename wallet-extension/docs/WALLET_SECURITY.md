# Security Best Practices: Password & Key Storage for Crypto Extensions

In a crypto wallet extension, the user's password is the **encryption key** for their funds. The primary goal is to ensure that even if an attacker gains access to the user's local files, they cannot access the private keys without the password.

---

## 1. The Core Workflow: Key Derivation
**Never store the actual password.** Instead, use it to derive a cryptographic key that unlocks a "vault."

* **Algorithm:** Use **Argon2id** (preferred) or **PBKDF2**.
* **Parameters:** If using PBKDF2, use at least **600,000 iterations** with SHA-256.
* **Salt:** Generate a unique, random salt for every user. Store this salt in `chrome.storage.local`.
* **Logic:** 1. User enters password.
    2. Password + Salt + KDF = **Master Key**.
    3. Use the Master Key to attempt to decrypt the vault.

## 2. Encryption at Rest (The Vault)
Store the sensitive data (Seed Phrase/Private Keys) in an encrypted blob.

* **Algorithm:** **AES-256-GCM**. This provides both confidentiality and data integrity.
* **Storage:** Store the resulting ciphertext in `chrome.storage.local`.
* **Warning:** `chrome.storage.local` is **not** encrypted by the browser. If the user's computer is compromised, this file is readable, which is why the AES encryption must be robust.

## 3. Session Management & Auto-Lock
To prevent the user from re-typing their password for every transaction, you must manage a "session" carefully.

* **Memory Only:** Store the decrypted private keys only in the **Background Service Worker RAM**.
* **Chrome Session API:** Use `chrome.storage.session` to store temporary state. This is cleared automatically when the browser is closed.
* **Auto-Lock:** Implement a `setTimeout` or idle listener that clears the Master Key from memory after a period of inactivity (e.g., 15 minutes).

## 4. Comparison of Storage Options

| Storage Method | Security Level | Best Use Case |
| :--- | :--- | :--- |
| **`chrome.storage.local`** | Medium | Salt, Encrypted Vault, Non-sensitive settings. |
| **`chrome.storage.session`** | High | Session state, cleared on browser close. |
| **`localStorage`** | Low | **Avoid.** Vulnerable to XSS and restricted in Service Workers. |
| **`chrome.storage.sync`** | Low | **Avoid.** Syncs data to Google's servers. |

## 5. Implementation "Don'ts"
* **Don't store the password hash:** Traditional web apps store hashes to "check" if a password is right. In a wallet, the password is right only if it successfully decrypts the vault.
* **Don't roll your own crypto:** Use audited libraries like `ethers.js`, `TweetNaCl.js`, or `noble-hashes`.
* **Don't put secrets in `manifest.json`:** Everything in the manifest is public.

---

> **Pro Tip:** When the user enters their password to "login," do not store the password string in a variable any longer than necessary. Clear the variable from memory immediately after the Master Key is derived.

---

## Chromatika (this repo) — how we map to the above

- **Vault:** `vault.ts` (primitives) + `vault-store.ts` (storage) + `wallet-service.ts` (orchestration) — **Argon2id** (RFC 9106 §4 second option: `t=3, m=64 MiB, p=4, dkLen=32`) via `@noble/hashes/argon2.js` (pure JS, no WASM), **AES-256-GCM**. Salt (16 bytes) is stable across re-encrypts within a vault; IV (12 bytes) rotates per encrypt. Persisted as `chromatika_vault_v3` in `chrome.storage.local`.
- **Unlock rehydrate:** the cache stores **derived AES-GCM key bytes** (b64) + KDF params in **`chrome.storage.session`** (`chromatika_unlock_cache_v1`). The plaintext password is **never** written to storage. On SW restart we re-import the bytes as a non-extractable `CryptoKey` and forget them. Legacy local-storage cache key is removed on unlock/write.
- **Session:** Decrypted `SessionState` holds a non-extractable AES-GCM `CryptoKey` (`vaultKey`) plus its `vaultKdfMeta` for re-encrypt — **never the password string**. Mnemonic + chain keypairs still live in SW RAM while unlocked (same trust boundary).
- **ika `UserShareEncryptionKeys` seed:** derived per **base chain** in `keyring/hd.ts`. Sui-base uses `ikaRootSeedFromFeeKeypair` = `keccak256(SuiKeyPair.to_bytes() || encryption_key_index_le)` to match ika CLI `resolve_seed`. Solana-base uses `ikaRootSeedFromSolanaKeypair` = `keccak256(secretKey64 || encryption_key_index_le)` over the canonical 64-byte `Keypair.secretKey` (Phantom / `solana-keygen` JSON shape). Solana-base imports therefore need only a Solana keypair, not a Sui privkey — Seeker / Solana-only onboarding works on its own.
- **Auto-lock:** `chrome.alarms` (`lock-manager.ts`) plus **`chrome.idle`** — wallet locks when the **OS screen locks** (not on browser “idle,” so long txn review in the popup is safe).
- **Sui PTBs:** `execute-transaction.ts` runs **`simulateTransaction`** (dry-run) before `signAndExecuteTransaction`; summary is attached as `suiSimulationSummary` on the result when useful for logs/UI.
- **EVM dapp `eth_sendTransaction`:** Approval popup calls **`getTxSimulationPreview`** — `eth_call` at latest block (no third-party key); shows revert vs success in the UI.
- **Ledger Sui:** WebHID signing runs only in the **popup** (`LedgerSigner`). For firmware / app version floors and practical PTB size notes, see [`LEDGER_SUI_LIMITS.md`](LEDGER_SUI_LIMITS.md).

## Dapp compatibility: Sui `signPersonalMessage`

- **`sui_signPersonalMessage`** (injected `window.sui` / Wallet Standard) is now **fully Mysten-standard** as of 2026-04-30. Flow: BCS-encode the caller-supplied message as `vector<u8>`, prepend the `PersonalMessage` intent prefix (`[3, 0, 0]`), **BLAKE2b-256** hash, then sign the 32-byte digest via the ika ed25519 MPC path. Returns a Mysten flag-prefixed serialized signature (`[0x00 || sig (64) || pubkey (32)]`).
- The digest computation lives in [`chains/sui-personal-message.ts`](../src/background/chains/sui-personal-message.ts) (`buildSuiPersonalMessageDigest`), shared with the dapp-bridge handler at [`dapp-bridge/sui.ts:sui_signPersonalMessage`](../src/background/dapp-bridge/sui.ts).
- Verified byte-for-byte compatible with `@mysten/sui` `Ed25519Keypair.signPersonalMessage` and `verifyPersonalMessageSignature` via the round-trip test at [`chains/sui-personal-message.test.ts`](../src/background/chains/sui-personal-message.test.ts).
- **Unblocks**: Sui dapps that verify with `verifyPersonalMessageSignature`; Seal's `SessionKey` flow (which uses Mysten's standard personalMessage scheme to authorize decryption-key fetches), so the SealBackend stub in `EncryptionBackend` can ship as a real implementation.

## Future hardening (tracked, not shipped)

1. ~~**`sui_signPersonalMessage` Mysten parity**~~ — ✅ shipped 2026-04-30; see "Dapp compatibility" section above.
2. ~~**Offscreen media cache**~~ — ✅ shipped 2026-05-10. `chrome.offscreen` document hosts an IndexedDB cache (`chromatika_media_cache_v1`, 100 MB / 7-day TTL) with `credentials: 'omit'` + `referrerPolicy: 'no-referrer'` on every fetch. NFT grid uses `<NftImage>` to mint per-instance blob URLs from cached bytes; cookies/referer no longer leak from the wallet's NFT rendering. See [`OFFSCREEN_MEDIA_CACHE.md`](OFFSCREEN_MEDIA_CACHE.md).
3. ~~**Sui JSON-RPC migration**~~ — ✅ shipped 2026-05-01. `nft.ts`, `sui-kiosk.ts`, and `activity.ts` all use `SuiGraphQLClient`. `activity.ts` uses a hand-rolled `Query.transactionBlocks(filter)` via `client.query` (see `queryTransactionBlocksGraphQL` at `sui-client.ts:306`) since `@mysten/sui` 2.16.x GraphQL core has no filtered/address-scoped transaction-list wrapper yet. The wallet no longer talks Mysten JSON-RPC at all.

### Shipped this revision (B1)

- Argon2id replaces PBKDF2 (was 900k iterations, SHA-256). Vault outer blob bumped `chromatika_vault_v2 → chromatika_vault_v3`.
- `SessionState.vaultPassword: string` replaced with `vaultKey: CryptoKey` (non-extractable) + `vaultKdfMeta`.
- Unlock cache stores derived key bytes (b64) instead of the plaintext password. Bytes are zeroed after `importKey`.
- **Pre-release breaking:** old v2 vaults are not migrated. Devs clear extension storage and re-onboard. `parseVaultBlob` rejects v2 with a clear message.

### Migration policy (when hardening ships)

- **Pre-release / dev installs** (current expectation): schema or KDF bumps may ship as **breaking** changes; users **clear extension storage** and re-onboard unless a task explicitly requires a migration tool.
- **After a public Chrome Web Store v1:** any vault format or KDF change needs a **versioned migration path** (detect old payload version, decrypt with old KDF, re-encrypt with new parameters), **automated tests**, and **release notes**. Until then, treat items (1) and (2) as **design backlog**, not silent upgrades.

## Optional third-party API keys (build-time)

- **`VITE_ALCHEMY_KEY`**, **`VITE_HELIUS_KEY`**: improve **EVM** and **Solana** NFT metadata fetch (`services/nft.ts`); without them those grids stay empty.
- **`VITE_CMC_API_KEY`**: enables **CoinMarketCap** as a price waterfall step after DefiLlama (`services/price.ts`). Keys are baked at **build** time; rotate in CI or local `.env` for production builds. Document host usage in store privacy disclosures.
- **`chromatika_price_waterfall_v1`** (`chrome.storage.local`): user-ordered list of **public** USD price providers (CoinGecko, DefiLlama, CMC, Pyth, Chainlink, GeckoTerminal). **Switchboard is not implemented** and is not stored here. No secrets.