# how to use Solana Mobile Wallet Adapter (local transport)

pair a Solana phone wallet (Seeker, Phantom Android, Solflare Android, Jupiter, etc.) running on the **same Android device** as chromatika via Mobile Wallet Adapter (MWA) `transact()`. the local transport launches the wallet via an Android intent (`solana-wallet://`) and gets a signature back over the same intent.

## prerequisites

- chromatika is running in a Chromium-based browser **on Android**
- a Solana mobile wallet supporting MWA 2.0 is installed on the same device
- WebView / system intent handling allows the `solana-wallet://` scheme
- your Chromatika vault is unlocked

## options at a glance

- **transport**: `local` (this guide). for desktop ↔ phone QR pairing, see [seeker-remote.md](/library/user/seeker-remote)
- **vendor**: `mwa` with `mwaTransport: 'local'` on the hardware vault record / hardware account

## how to pair an MWA local account

1. trigger MWA `transact()` from the popup or side-panel context (cannot run in the service worker - the lib touches `window` APIs)
2. Android dispatches the intent; pick the Solana wallet you want to authorize
3. the wallet returns the authorized account public key + auth metadata
4. submit `addHardwareAccount` with: `vendor: 'mwa'`, `chain: 'solana'`, `derivationPath`, `address`, `ed25519PublicKeyB64`, plus the transport-specific metadata (`mwaTransport: 'local'`)

## how to sign with MWA local

1. operations that need a Solana signature on this account enqueue a hardware-sign request, open the hardware-sign popup
2. popup runs `transact()` again to dispatch the sign intent to the matching wallet
3. you approve on the wallet, signature returns over the intent
4. popup calls `resolveHardwareSign` with the signature, or `rejectHardwareSign` to cancel

## how to use this account as a hardware-primary vault root

the local-MWA account can also seed a hardware-primary chromatika vault (Solana base). see [hardware-vault.md](/library/user/hardware-vault) - same flow as remote, just dispatched over local intents instead of the QR-paired reflector

## notes

- the local transport only works because the wallet and chromatika are on the **same Android device**. on desktop or iOS, you have to use the remote transport
- chromatika gates the MWA local entry on UA - it only surfaces the option when the user agent matches Android
- intent dispatch is not catchable inside the service worker. the popup / side-panel context is mandatory
- Seed Vault never reveals key bytes, so MWA + Solana base vaults still need an in-extension Solana keypair to pay ika gRPC `approve_message` fees - the vault auto-generates this (`ikaGrpcFeePayerSolSecretKeyB64`). see [ika-fee-management.md](/library/user/ika-fee-management)
