# how to use multi-vault siblings (one identity, multiple dwallets)

chromatika now supports **multiple distinct vaults backed by a single identity** at different bip44-style indices. this lets you treat one passkey / hardware wallet / waap login / lazor smart-wallet / seed phrase as a "master identity" and have several functionally separate dwallet vaults underneath — same on-chain identity address, different cross-chain (EVM / BTC / Solana / Aptos) addresses per sibling.

## what does "sibling vault" mean here?

a **sibling vault** is a chromatika vault record that:

- shares the same identity field as another vault (same `passkeyCredentialId` / `hardwareAccountId` / `waapSuiAddress` / `lazorSmartWalletPubkeyB58` / mnemonic + accountIndex)
- has its own `ikaEncryptionIndex` (or `passkeyEncryptionIndex` on passkey records / `accountIndex` on HD records)
- produces its own `UserShareEncryptionKeys` → its own dwallet → its own EVM / BTC / Solana / Aptos addresses
- is unlocked alongside its siblings under the same chromatika password

think of it as bip44 accounts on top of an identity that doesn't have a built-in account-index concept (passkey, hardware, waap, lazor).

## which methods support siblings?

- **passkey** ✅ via `passkeyEncryptionIndex` (auto-detect on `addPasskeyVault`)
- **hardware (Seeker / WC / Ledger)** ✅ via `ikaEncryptionIndex` (auto-detect on `addHardwareVault`)
- **waap** ✅ via `ikaEncryptionIndex` (auto-detect on `addWaapVault`)
- **lazor** ✅ via `ikaEncryptionIndex` (auto-detect on `addLazorVault`)
- **HD seed phrase** ✅ via `accountIndex` (BIP44 standard); use `importVaultsBatch` for bulk import
- **imported private key** ❌ one privkey = one keypair = one address; multi-vault not possible
- **dwallet-anchored** ❌ vault IS one specific dwallet by definition

## how to add a sibling vault (passkey / hardware / waap / lazor)

### option A — via "find more accounts" inline flow

1. unlock chromatika
2. open settings → "find more accounts"
3. (active vault is one of passkey / hardware / waap / lazor) click "add sibling vault →"
4. the panel section flips to "add sibling vault" and mounts the inline setup flow
5. re-run the per-method auth dance:
   - passkey: tap Touch ID / Face ID / hardware key for the same credential
   - seeker: re-pair via QR / Android intent
   - waap: log back in with email / social
   - lazor: open the portal + authenticate with the same lazor passkey
6. background `add{Passkey,Hardware,Waap,Lazor}Vault` auto-picks `max(existingIndices) + 1`
7. you land on a new active vault with fresh cross-chain addresses

### option B — via vault management

1. unlock chromatika
2. open settings → "manage dWallet vaults" → "add vault"
3. pick the same method as your existing vault
4. complete the auth dance — same auto-detect logic kicks in regardless of entry point

## how to import multiple HD accounts from one phrase

see [`import-vault-mnemonic.md`](/library/user/import-vault-mnemonic) → "advanced: scan derivation paths first." flow:

1. paste phrase + password during onboarding's import step
2. expand the advanced toggle, click "scan now"
3. pick which BIP44 accounts to import (chromatika auto-suggests anything with activity)
4. click "import N selected" → `importVaultsBatch` persists one HD vault record per picked `accountIndex`

each HD sibling has DIFFERENT Sui / Solana / EVM addresses (account index changes the derivation path) plus its own dwallet — distinct from the passkey-style siblings where the on-chain identity address stays the same.

## switching between siblings

1. open settings → "manage dWallet vaults"
2. click the sibling you want to make active
3. chromatika rebuilds the session against that vault's `ikaShareKeysB64` and dwalletMeta
4. dapp bridge re-emits account-changed events to connected origins so dapps see the new addresses

## use cases

- **personal vs work**: one Touch ID, two vaults — keep DeFi positions on a "personal" sibling, NFT minting + speculative trades on a "work" sibling
- **clean separation by purpose**: same Seeker on your Solana phone backs three siblings — long-term savings (index 0), spending wallet (index 1), throwaway test wallet (index 2)
- **hardware wallet redundancy**: single Ledger device, multiple sibling vaults at different ika encryption indices for compartmentalized risk
- **HD account ladder**: import a phrase, scan, see you had activity on accounts 0, 1, and 4 (and maybe a previously-orphaned cap on account 2); import all four as siblings in one click

## binding an orphan dwallet via sibling-add

the "find more accounts" panel surfaces orphan caps (dwallets on chain at your identity that no local vault references). most often these come from re-installing chromatika without using the same authenticator OR from having previously created sibling vaults that didn't get carried forward.

to bind an orphan:

1. note the orphan count in the panel header (e.g. "· 1 orphan")
2. click "add sibling vault →" — chromatika auto-picks `max(existingIndices) + 1`
3. complete the auth dance
4. the new sibling's ika encryption index might match the orphan's — re-running the scan shows the orphan count dropped to 0

if the orphan persists after sibling-add, its index is higher than `max(existingIndices) + 1`. add multiple siblings (each one bumps the index) until the inventory shows zero orphans.

## notes

- **same identity ≠ same vault**: siblings share the on-chain identity address but have distinct ikaShareKeys, dwallets, and cross-chain addresses
- **passwords are global**: one chromatika password unlocks the whole `chromatika_vault_v3` blob — all siblings unlock together
- **per-vault state**: presign pools (`chromatika_presign_pools_v3_<vaultId>`) and dwalletMeta overlay (`chromatika_dwallet_meta_v2_<vaultId>`) are scoped per sibling, so switching vaults doesn't bleed state between them
- **fee payers**: hardware / lazor siblings share the same gRPC fee-payer keypair (derived deterministically from the wallet signature / phrase, NOT from the encryption index) — fund it once, all siblings use it
- **migrations**: dev installs from before the sibling-index plumbing landed have no `ikaEncryptionIndex` / `passkeyEncryptionIndex` field on their records — chromatika treats `undefined` as `0` so nothing breaks
- **e2e**: a `?syntheticInventory=<orphans>:<matched>` dev-harness flag exercises the inline-flow render path without needing real siblings (gated on `import.meta.env.DEV`)
