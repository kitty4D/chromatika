# dWallet Vault product model

This document describes the **target** multi–dWallet Vault model, how it differs from **today’s** extension, and a **phased implementation** outline. Terminology is defined in [`TERMINOLOGY.md`](TERMINOLOGY.md).

**Release status:** Chromatika has **not** shipped a public Chrome Web Store build. There are no production users to migrate from. Multi-vault schema work can introduce new `VaultPayload` versions directly; breaking changes during development are acceptable if local test profiles reset or re-onboard. (After a public v1 exists, later schema bumps would need a real migration plan.)

## Target model (product)

1. User sets **ika base chain** to **Sui** or **Solana** (global mode / scope for vaults and dWallets on that anchor).
2. User **creates** a new **dWallet Vault** (owner wallet, not a dWallet): receives a mnemonic to back up, or **imports** an existing owner wallet (mnemonic; private key; hardware; dWallet-anchored — **no** OAuth / zkLogin vault in Chromatika).
3. Chromatika **adds** that owner wallet to the **dWallet Vault list** for the chosen base chain.
4. For an **imported** dWallet Vault, the app **discovers** ika **dWallets** already owned by that identity and **loads** them into the dWallet list for that vault.
5. User may add **another** dWallet Vault on the same base chain (new mnemonic or another import).
6. If **more than one** dWallet Vault exists for the active base chain, the user **picks** a vault; if exactly **one**, it is **selected automatically**. Then the user sees **dWallets** for that vault (and picks an active dWallet where relevant).

## Current implementation (today)

- **Multi–dWallet Vault** storage is live: `chromatika_vault_v2` encrypts a JSON blob; on load, **v2** payloads migrate to **v3** (`VaultPayload` in [`vault-types.ts`](../src/background/vault-types.ts)). Session exposes vault list, picker, and per-vault `dwalletMeta` keyed by curve (`SECP256K1` / `ED25519`) with `baseChain`, `dwalletId`, share ids, optional `parentDwalletId`, etc.
- **Ika base mode** preference (`chromatika_ika_base_mode_v1`) selects **Sui** vs **Solana** for new vault scope. **Solana ika** uses **pre-alpha** devnet flows (gRPC + mock signer — **not** production MPC). Pre-alpha disclaimer surfaces in the root README + every Solana ika UI surface; do not submit real-value transactions on this stack.

## Implementation status (engineering)

| Epic phase | Status |
|------------|--------|
| **Phase 1** — multi-record `chromatika_vault_v2`, per–dWallet Vault `VaultRecord`, one app password encrypts the blob | **Shipped** |
| **Phase 2** — `SessionState.activeVaultId`, vault switch / re-encrypt, per-vault `chromatika_dwallet_meta_v2_<vaultId>`, `chromatika_presign_pools_v3_<vaultId>` | **Shipped** |
| **Phase 3** — import-time and refresh **dWallet discovery** (indexer-quality merges) | **Partial** — incremental discovery exists; full “import and reconcile all owned dWallets” remains product-dependent |
| **Phase 4** — vault picker, dWallet list, onboarding into vault list | **Largely shipped** — continue polishing UX |
| **Phase 5** — private key / hardware / passkey / WaaP / Lazor vault records | **Largely shipped** — see [`vault-types.ts`](../src/background/vault-types.ts) (`HdVaultRecord`, `ImportedKeyVaultRecord`, `HardwareVaultRecord`, `PasskeyVaultRecord`, `WaapVaultRecord`, `LazorVaultRecord`, `DwalletAnchoredVaultRecord`); hardware needs **suiPrivateKeyBech32** in vault until Ledger Sui PTBs ship; **zkLogin vault kind removed** from the product |
| **Phase 6** — dWallet-anchored vaults, nested tree | **Partial** — anchored vault + discovery owner via [`anchored-discovery-address.ts`](../src/background/ika/anchored-discovery-address.ts); nested UX is a future direction, not currently scheduled |

This doc + the table above are the **source of truth** for done vs remaining.

So: the **target story** above is the north star; **shipping it** requires schema, session, and UI work, not only copy.

## Design caveats

| Topic | Note |
|-------|------|
| **Chromatika vault vs dWallet Vault** | One app password can encrypt a **structured store** of many dWallet Vault records. Keep naming split (see TERMINOLOGY). |
| **Discovery** | “Find existing dWallets on import” needs explicit **on-chain / ika API** strategy (owner address, events, indexer). |
| **12 vs 24 word mnemonics** | Product choice; BIP39 supports both with validation + UX updates. |
| **Import variants** | `VaultAccountKind` in [`vault-types.ts`](../src/background/vault-types.ts): `hd`, `importedKey`, `hardware`, `dwalletAnchored`, `passkey`, `waap`, `lazor`. |

## Phased implementation epic (remaining work)

Phases **1–2** in the original write-up are **done** (see **Implementation status**). Below tracks **what is still open** relative to the target model. There is **no** migration obligation from prior *released* installs (none exist).

### Phase 1 - Storage and schema (complete)

- Versioned **Chromatika vault** with multiple **dWallet Vault** records lives in `chromatika_vault_v2` (`wallet-service.ts`, `vault.ts`).

### Phase 2 - Session and active selection (complete)

- [`SessionState`](../src/background/session.ts) carries **`activeVaultId`**, **`activeVaultBaseChain`**, vault-scoped meta and presign pools; **`switchVault`** rebuilds session from the selected record.

### Phase 3 - Discovery APIs

- Implement **import-time (and refresh) discovery**: query ika / Sui (and later Solana) for dWallet objects owned by the vault’s addresses; merge into local list per curve.
- Handle **partial** state (DKG in progress, missing shares) consistently with today’s [`dwallet-lifecycle.ts`](../src/background/ika/dwallet-lifecycle.ts).

### Phase 4 - UI (largely shipped; polish ongoing)

- **Vault list** when count > 1 for active ika base mode; auto-select when count === 1 — **in app today**; refine copy and edge cases as needed.
- **dWallet list** under the selected vault; align with “active dWallet” rules in the README.
- Onboarding / setup flows: create or import **into** the vault list for the selected base chain.

### Phase 5 - Additional import methods

- **Private key** — shipped for Sui `suiprivkey` (+ Solana ika: base64 Solana keypair) via onboarding + `addVaultImportedFromPrivateKey` / `importVaultFromPrivateKey` (tRPC).
- **Hardware** — vault kind + `hardwareAccountId`; ika fees still use **suiPrivateKeyBech32** in vault until Ledger Sui signs PTBs in-app.

### Phase 6 - dWallet-anchored + nested (partial)

- **Anchored** — `addVaultDwalletAnchored` + discovery owner from anchor’s Active `public_output` when possible.
- **Nested** — optional `parentDwalletId` on `DWalletMeta`; full tree UI gated on ika spike.

---

Update this doc when a phase ships so agents and humans do not confuse **current** vs **target** behavior.
