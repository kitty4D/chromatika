# how to use Solana Mobile Wallet Adapter (remote transport)

pair a Seeker (or any MWA-compliant phone wallet that supports the reflector protocol) with chromatika running on a **desktop** via QR-coded MWA remote transport. the wallet to extension link uses a websocket reflector at `wss://development.reflector.solanamobile.com` and an `auth_token` so subsequent signs reauthorize without rescanning the QR.

## prerequisites

- chromatika is running on a desktop Chromium browser (popup or side-panel context)
- a phone with an MWA 2.0 wallet that can scan a chromatika QR or accept a `solana-wallet://` association URL (Seeker built-in, Phantom Android, Solflare Android, Jupiter)
- network access to `wss://development.reflector.solanamobile.com`
- chromatika manifest allows wss connections (CSP `connect-src *` covers this today; will tighten when product surface stabilizes)
- your Chromatika vault is unlocked

## options at a glance

- **transport**: `remote` (this guide). for same-device Android, see [seeker-local.md](/library/user/seeker-local)
- **reflector host**: defaults to `MWA_REMOTE_HOST_AUTHORITY` (Solana Mobile's public reflector). a self-hosted Cloudflare Workers reflector exists in `/reflector` as a fallback; do not use it unless the public host is down
- **persisted auth**: `auth_token` + `reflectorHost` saved on the vault record so reauth runs silently

## how to pair a Seeker via QR

1. trigger `startRemoteScenario()` from the popup / side-panel - this opens the websocket from `window`-having context (the service worker cannot, the library uses `btoa` / `atob`)
2. read the resulting association URL and render it as a QR code
3. scan the QR with the Seeker camera or the wallet's "scan link" input
4. approve in Seed Vault (or whichever wallet you're using)
5. wallet hands back: account pubkey, ed25519 public key, `auth_token`, the reflector host
6. submit `addHardwareAccount` with: `vendor: 'mwa'`, `chain: 'solana'`, `mwaTransport: 'remote'`, `address`, `ed25519PublicKeyB64`, plus the auth metadata

## how to sign with MWA remote

1. signing operations enqueue a hardware-sign request, open the popup
2. popup reauthorizes against the persisted `auth_token` (no new QR), dispatches the sign request through the reflector
3. you approve on the phone (Seed Vault on Seeker)
4. signature returns through the reflector, popup resolves via `resolveHardwareSign`

## how to re-pair when authorization fails

1. an `ERROR_AUTHORIZATION_FAILED` from the wallet means the `auth_token` is invalid (revoked, expired, wallet uninstalled, etc.)
2. `MwaSigner` flips into `needsRepair` state; trigger `startRemoteScenario()` again to render a fresh QR
3. scan + approve, the new `auth_token` overwrites the old one

## how to derive the ika seed for a hardware-primary vault

the remote-MWA path is also how a hardware-primary Chromatika vault on Solana base gets its ika `UserShareEncryptionKeys` root seed:

1. ask the wallet to sign `IKA_USK_DERIVATION_MESSAGE` (constant `'ika.chromatika.user-share-encryption-key.v1'`)
2. Ed25519 is deterministic per RFC 8032, so the same wallet on a different device produces the same signature - means restore-on-new-machine works without any HD seed
3. `keccak256(signature)` is the 32-byte seed
4. see [hardware-vault.md](/library/user/hardware-vault) for the full vault create flow

## notes

- the public reflector at `development.reflector.solanamobile.com` is the tested host - all shipping wallets are tested against it. self-hosted reflectors can have wallet-side allowlists or untested paths cause silent UI freezes; don't switch hosts unless you have to
- a separate fee-payer keypair (`ikaGrpcFeePayerSolSecretKeyB64`) is auto-generated per install for `approve_message` ika gRPC fees - fund it with ~0.1 devnet SOL after vault create. see [ika-fee-management.md](/library/user/ika-fee-management)
- deprecated field `ikaEncryptionOnlySolSecretKeyB64` reads as fallback for old dev installs but receives no new writes
- runbook: `wallet-extension/docs/SEEKER_REMOTE_PAIRING.md`
