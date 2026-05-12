# how to import a chromatika vault from an existing mnemonic

bring an existing BIP39 mnemonic into chromatika as a dWallet Vault. used when restoring onto a new install or migrating from another wallet with standard BIP39 derivation.

## prerequisites

- no chromatika vault exists on this install yet (or you've cleared storage)
- the BIP39 mnemonic words you want to import (12 or 24)
- a new local password 8+ chars (does not have to match any prior password)
- decide your ika base chain (Sui default; Solana needs `VITE_SOLANA_IKA_BASE=true`)

## options at a glance

- **base chain**: sui or solana (pre-alpha)
- **label**: human-readable vault name (set now, rename later)

## how to import the vault

1. submit `importVault` with: the mnemonic, password, base chain, optional label
2. background derives keyring, encrypts vault with Argon2id + AES-GCM, persists to `chromatika_vault_v3`
3. session unlocks immediately

## how to recover dWallets that already exist on-chain for this mnemonic

1. after import, trigger `discoverDWallets` per curve (SECP256K1 and ED25519)
2. dWallets the chain knows about for your derived addresses come back as active cards
3. set the dWallet you want to use as active per curve via `setActiveDwallet`

## advanced: scan derivation paths first (BIP44 multi-account import)

new: the import step has an **"advanced: scan derivation paths first"** expander. when toggled, instead of importing only account 0, chromatika probes BIP44 accounts 0..N on this phrase across Sui mainnet + Solana mainnet + Solana devnet for activity / balances / existing dwallets. you pick which accounts to import as separate sibling vaults from one phrase.

flow:
1. type / paste the recovery phrase
2. click "advanced: scan derivation paths first" → expand
3. (optional) check super-pro chains (EVM L2s + Bitcoin + Aptos + DeSo + Cosmos + Polkadot) for broader coverage
4. click "scan now"
5. results table shows each account index with its sui / solana / evm addresses + balances + tx counts
6. check the accounts you want to import (chromatika auto-suggests any with activity + always the default account 0)
7. click "import N selected" → `importVaultsBatch` persists one vault record per picked account index, all sharing the same phrase but with distinct `accountIndex` values

every persisted vault gets a different `feeMaterialFromVaultRecord` keypair (per its `accountIndex`), so signing + sending behave as expected for each.

## notes

- dWallets are not in the mnemonic itself - they're MPC objects on Sui or Solana. importing the mnemonic restores your owner identity, on-chain discovery does the rest
- if no dWallet ever existed for this mnemonic, just create one (see [create-dwallet.md](/library/user/create-dwallet))
- the ika `UserShareEncryptionKeys` root seed is derived **per base chain**:
  - Sui base → fee-payer keypair via `ikaRootSeedFromFeeKeypair`
  - Solana base → Solana fee-payer keypair via `ikaRootSeedFromSolanaKeypair`
  - same mnemonic on a different base chain produces a **different** ika identity
- to reuse the same mnemonic on the opposite base chain as a sibling vault, use the cross-chain mnemonic reuse path (see [manage-vaults.md](/library/user/manage-vaults))
- the BIP44 account index is now persisted on `HdVaultRecord.accountIndex`; old records (no field) treat it as `0` so single-account imports keep working unchanged
