# how to create a chromatika vault

spin up a brand-new install with a fresh BIP39 mnemonic and a fresh dWallet Vault (the owner keyring for an ika base chain).

## prerequisites

- no chromatika vault already exists on this install (or you've wiped extension storage - chromatika is pre-release, no migrations)
- a password at least 8 characters
- decide your ika base chain
  - **Sui base** (default): no extra flag
  - **Solana base** (pre-alpha, dev only): the build needs `VITE_SOLANA_IKA_BASE=true`. signatures come from a single mock signer, not real MPC - never trust this for real value

## options at a glance

- **mnemonic word count**: 12 (default, BIP39 standard) or 24
- **mnemonic source**: auto-generated in the background, or provide your own
- **base chain**: sui or solana (pre-alpha)
- **label**: optional human-readable name for this dWallet Vault (rename later anytime)

## how to create a vault with an auto-generated mnemonic

1. request a setup mnemonic from the background (`generateSetupMnemonic`) and pick word count (12 or 24)
2. record the words offline. this is the only backup of your dWallet Vault root key - chromatika cannot recover it for you
3. submit `createVault` with: password (8+ chars), the mnemonic, base chain, optional label
4. the background derives the keyring (BIP39/44 + SLIP10 ed25519), encrypts the vault blob with Argon2id (RFC 9106 §4 second option: t=3, m=64 MiB, p=4) + AES-256-GCM, and writes it to `chromatika_vault_v3` in `chrome.storage.local`
5. session unlocks immediately - no need to re-enter the password

## how to create a vault with mnemonic you already have

1. supply your existing mnemonic words instead of asking for generation
2. submit `createVault` with: password, your mnemonic, base chain, optional label
3. same encryption + persistence path

## how to create your first dWallet right after vault setup

1. pick a curve: **SECP256K1** for EVM and BTC addresses, **ED25519** for Sui, Solana, and Aptos addresses
2. fund the dWallet Vault with the IKA + SUI (or solana) the DKG flow needs - call `getRequiredCoinAmounts` for the current minimum with a 10% buffer
3. run `createDWallet` for the chosen curve
4. complete the zero-trust accept-share step (`completeDWalletZeroTrust`) once DKG returns `awaiting_key_holder_signature`

## notes

- a fresh mnemonic + create flow is the only path that gets you a sovereign new identity. importing existing seeds, hardware vaults, passkey vaults, etc. each have their own guide
- the password never sits in RAM as a string - the unlock cache stores derived AES key bytes (b64) in `chrome.storage.session` only, never plaintext
- session auto-locks after the configured inactivity window (1-1440 minutes, default 30); see [unlock-and-lock.md](/library/user/unlock-and-lock)
- changing word count or base chain after creation is not a thing - it would be a new vault. use `addVault` (see [manage-vaults.md](/library/user/manage-vaults)) to keep both
- you don't need a separate "plain HD" identity for dapps. all dapp + on-chain activity goes through dWallets anchored to your dWallet Vault
