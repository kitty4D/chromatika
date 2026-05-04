# how to import a chromatika vault from a private key

import a single raw private key (Sui or Solana flavor) as a dWallet Vault. handy for one-off accounts that aren't HD-derivable, or for Solana-only / Seeker-style onboarding where there is no Sui privkey to provide.

## prerequisites

- a password 8+ chars (or the wallet is already unlocked when adding as a sibling vault)
- the raw key in canonical form:
  - **Sui**: `suiprivkey…` bech32 string (the export format Sui Wallet, sui-keytool, etc. give you)
  - **Solana**: 64-byte secret key, base64-encoded (the same shape Phantom and `solana-keygen` JSON export use, just b64 instead of JSON array)
- decide your ika base chain - the key flavor must match. you cannot import a Sui privkey under Solana base or vice versa
- Solana base requires `VITE_SOLANA_IKA_BASE=true` in the build

## options at a glance

- **key flavor**: sui bech32 OR solana 64-byte secret (b64)
- **base chain**: must match key flavor
- **label**: human-readable vault name

## how to import as your first vault

1. submit `importVaultFromPrivateKey` with: password, base chain, the matching key field (`suiPrivateKeyBech32` for Sui, `solanaSecretKeyB64` for Solana), optional label
2. background reconstructs the keypair, derives ika encryption keys per base chain, encrypts the vault, writes `chromatika_vault_v3`
3. session unlocks immediately

## how to import as a sibling vault (existing chromatika install)

1. unlock the existing vault, or include the password in the call
2. submit `addVaultImportedFromPrivateKey` with the same fields
3. the new vault joins the list; switch to it via `switchVault`

## how to discover dWallets that already exist for this key

1. after import, trigger `discoverDWallets` per curve
2. owned dWallets on the chain return as cards
3. set active per curve via `setActiveDwallet`

## notes

- importing a raw key gives you a single account, not an HD tree. there are no derivation children
- on Solana base, the imported keypair seeds the ika `UserShareEncryptionKeys` root via `keccak256(secretKey64 || encryption_key_index_le)`. on Sui base, the equivalent for the bech32 key
- this is the same path Seeker / Solana-only onboarding uses internally, just driven by you instead of by Mobile Wallet Adapter pairing
- never paste a private key from a hardware wallet into this flow - hardware devices are designed to never reveal that material. use the hardware vault flow instead (see [hardware-vault.md](/library/user/hardware-vault))
