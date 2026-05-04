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

## notes

- dWallets are not in the mnemonic itself - they're MPC objects on Sui or Solana. importing the mnemonic restores your owner identity, on-chain discovery does the rest
- if no dWallet ever existed for this mnemonic, just create one (see [create-dwallet.md](/library/user/create-dwallet))
- the ika `UserShareEncryptionKeys` root seed is derived **per base chain**:
  - Sui base → fee-payer keypair via `ikaRootSeedFromFeeKeypair`
  - Solana base → Solana fee-payer keypair via `ikaRootSeedFromSolanaKeypair`
  - same mnemonic on a different base chain produces a **different** ika identity
- to reuse the same mnemonic on the opposite base chain as a sibling vault, use the cross-chain mnemonic reuse path (see [manage-vaults.md](/library/user/manage-vaults))
