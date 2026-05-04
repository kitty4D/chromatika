# how to set up a hardware-only vault

create a chromatika vault whose **primary** signing identity is a hardware wallet, with no software-held mnemonic for the dWallet Vault. today the supported primary path is **Solana Mobile Wallet Adapter (MWA)** with a Seeker / phone wallet. Ledger and Trezor remain hardware accounts inside an existing software vault rather than primary vaults (per status doc).

chromatika **never** asks for a private key, seed phrase, or recovery export from a hardware device. anything that resembles "paste your hardware seed here" is wrong by design.

## prerequisites

- you've already paired the hardware account in chromatika and it shows up in `getHardwareAccounts`
  - for MWA local (Android Chrome same-device): see [seeker-local.md](/library/user/seeker-local)
  - for MWA remote (desktop ↔ phone QR pair): see [seeker-remote.md](/library/user/seeker-remote)
- the hardware-derived ika user-share signature is available - chromatika asks the device to sign `IKA_USK_DERIVATION_MESSAGE` (constant `'ika.chromatika.user-share-encryption-key.v1'`); `keccak256(signature)` is the deterministic 32-byte seed for `UserShareEncryptionKeys`
- a password 8+ chars (the password protects local artifacts like the in-extension fee-payer keypair, even though the dWallet Vault root is hardware-derived)
- base chain: Solana (the hardware-only path is solana-base today). Sui-base hardware-only vault is deferred

## options at a glance

- **vendor / transport**: MWA local (Android only), MWA remote (any desktop pairing with a Seeker / Phantom / Solflare phone), WalletConnect (for the x402 path)
- **label**: human-readable vault name

## how to create a hardware-primary vault (first vault)

1. pair the hardware account first (see [seeker-local.md](/library/user/seeker-local) or [seeker-remote.md](/library/user/seeker-remote))
2. ask the device to sign `IKA_USK_DERIVATION_MESSAGE` once - record the resulting `ikaUskSignatureB64`
3. submit `createVaultHardware` with: password, `hardwareAccountId`, `ikaUskSignatureB64`, `baseChain: 'solana'`, label, MWA / WalletConnect transport params
4. background derives the ika seed via `keccak256(signature)`, generates an in-extension Solana keypair for ika gRPC `approve_message` fees (`ikaGrpcFeePayerSolSecretKeyB64` on the vault record), encrypts the vault, persists
5. fund the in-extension fee-payer with a small amount of devnet SOL (~0.1) so ika operations have gas

## how to add a hardware-primary vault as a sibling

1. unlock the wallet (or include password)
2. follow the same pairing + signing flow as above, then submit `addVaultHardware`

## how to recover a hardware vault on a new install

1. on the new install, pair the **same** hardware account through the matching transport
2. ask the device to sign the same `IKA_USK_DERIVATION_MESSAGE` - because Ed25519 is deterministic per RFC 8032, the same key produces the same signature on any device, so `keccak256(signature)` is the same 32-byte seed
3. recreate the vault via `createVaultHardware` (you provide a new local password; the ika identity is recovered from the device, not the password)
4. discover dWallets on-chain (`discoverDWallets`) to repopulate the dWallet list

## how to drain the in-extension fee-payer back to your hardware account

1. when wrapping up or rotating, call `drainIkaFeePayerToSeeker` to send the residual SOL back to your phone wallet (default = full balance minus rent + a fee buffer)
2. for an abandoned `seeker_direct` vault, use `drainAbandonedFeePayer` to drain the persisted keypair without prompting the phone

## notes

- the in-extension fee-payer keypair only signs `approve_message` gRPC fees for ika pre-alpha. **every chain transaction** (sends, dapp signing, dWallet authorize) goes back to the hardware device. there is no software signing of "your money"
- a deprecated field `ikaEncryptionOnlySolSecretKeyB64` is read as a fallback for old dev installs but receives no new writes; those vaults are not portable and should be re-onboarded
- Ledger and Trezor are hardware **accounts** today (per `getHardwareAccounts` / `addHardwareAccount`). they sign tx and messages but are not a hardware-primary vault root - the dWallet Vault is still mnemonic-backed for those flows
