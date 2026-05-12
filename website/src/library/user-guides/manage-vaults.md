# how to manage multiple chromatika vaults

chromatika supports multiple dWallet Vaults under one app password / unlock. each vault has its own ika base chain, its own keyring, and its own dWallet list. this guide covers everything you do **after** the first vault exists.

## prerequisites

- at least one chromatika vault already exists
- session is unlocked, or you're willing to pass the password through on each call

## options at a glance

- **add sibling vault**: spawn another vault under the same app password
- **switch active**: change which vault drives dapp / signing flows
- **rename**: change the human label
- **remove**: delete a vault (cannot remove the last one)
- **list**: get all vault summaries
- **cross-chain mnemonic reuse**: preview re-using a mnemonic on the opposite ika base chain

## how to list all vaults

1. call `listVaults` (returns vault id, label, base chain, primary credential type, dWallet count)
2. read `activeVaultId` to know which one is currently driving signing

## how to add a sibling vault

pick the variant that matches how you want the new vault to authenticate:

- mnemonic (HD): `addVault` with password (or unlocked session), base chain, `mnemonic`, `wordCount`, label
- private key: `addVaultImportedFromPrivateKey` with the matching key field
- passkey: `addVaultPasskey` with the WebAuthn params
- WAAP: `addVaultWaap` with auth method + WAAP address / pubkey
- Lazor: `addVaultLazor` with smart-wallet pubkey + credentialId
- hardware: `addVaultHardware` with paired hardware account id + `ikaUskSignatureB64`
- dWallet-anchored: `addVaultDwalletAnchored` (vault rooted on an existing on-chain dWallet)

each path mirrors the equivalent `createVault*` call; see the respective vault guide for the input shape.

## how to switch active vault

1. call `switchVault` with the target `vaultId` (and password if locked)
2. session re-encrypts where required; `activeVaultId` updates; presign pools and dWallet meta scope to the new vault (`chromatika_presign_pools_v3_<vaultId>`, `chromatika_dwallet_meta_v2_<vaultId>`)
3. dapp bridge re-emits account-changed events to connected origins

## how to rename a vault

1. call `renameVault` with `vaultId` and the new `label`
2. label is purely cosmetic; keys / addresses don't change

## how to remove a vault

1. call `removeVault` with `vaultId` (and password if needed)
2. the encrypted record + per-vault overlays are dropped from storage
3. you cannot remove the last vault - chromatika needs at least one to function. add a new one first if you want to discard the current one

## how to preview cross-chain mnemonic reuse

1. call `previewCrossChainReuseMnemonic` with the source `vaultId` and the new base chain (Sui ↔ Solana)
2. preview shows what the new dWallet Vault would look like on the opposite base chain - new ika user-share root seed, new addresses
3. if you want to commit, follow up with `addVault` (mnemonic flow) using the previewed mnemonic and the new base chain

## notes

- presign pools, dWallet meta, and most session-state are **per vault**. switching vaults does not bleed pool entries between vaults
- the password is shared across all vaults in the install - one app password protects the whole `chromatika_vault_v3` blob (which contains every vault record)
- mnemonic reuse across base chains is not the same identity - the ika `UserShareEncryptionKeys` root seed is derived per base chain, so the dWallet identity differs even though the BIP39 words match
- syncing `dwalletMeta` to chrome.storage manually (e.g. after experimentation): `syncVaultMeta`

## multi-vault siblings from a single identity (passkey / seeker / waap / lazor / HD)

beyond "different vaults using different identities," chromatika now also supports **multiple vaults backed by the SAME identity** at different bip44-style indices:

- **passkey**: `passkeyEncryptionIndex` field; same passkey credential, different ika seeds per index → same Sui address, different cross-chain (EVM/BTC/Solana/Aptos) addresses
- **hardware (Seeker / WC / Ledger)**: `ikaEncryptionIndex` field; same hardware identity, different dwallets
- **waap**: `ikaEncryptionIndex` field; same waap login, different dwallets
- **lazor**: `ikaEncryptionIndex` field; same lazor smart wallet, different dwallets
- **HD seed phrase**: `accountIndex` field; standard BIP44 account derivation — different Sui / Solana / EVM addresses per index

`addPasskeyVault` / `addHardwareVault` / `addWaapVault` / `addLazorVault` auto-detect the matching identity in your existing vault list and pick `max(existingIndices) + 1`. Re-pair / re-register the same identity → chromatika produces a sibling vault automatically.

see [multi-vault-siblings.md](/library/user/multi-vault-siblings) for the full UX, including the post-unlock "find more accounts" panel that surfaces orphan dwallet caps + lets you bind them via inline sibling-add.
