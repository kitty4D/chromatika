# how to use WalletConnect for remote signing

WalletConnect is a remote signer transport - phone wallets like Seeker, Phantom, and Solflare can sign for chromatika over the WalletConnect relay. today this is wired specifically for the **x402 Solana payment** path (so the ed25519 key never leaves the phone), and as a generic hardware-sign vendor (`vendor: 'walletconnect'`).

## prerequisites

- chromatika is running in popup or side-panel (WC transport touches `window` APIs)
- a WalletConnect-compatible phone wallet
- network access to the WalletConnect relay
- your Chromatika vault is unlocked

## options at a glance

- **vendor**: `walletconnect`
- **kind**: `solanaTx` for x402 payments (today). other WC kinds are open as the surface grows
- **session lifetime**: WC sessions live until revoked; chromatika persists session metadata to skip re-pair

## how to pair a WalletConnect account

1. trigger the WC pairing flow from the popup / side-panel - generates a WC URI
2. render the URI as a QR or hand it to the phone wallet's WC paste input
3. approve the WC session on the phone
4. submit `addHardwareAccount` with: `vendor: 'walletconnect'`, `chain` (`solana` for x402), `address`, `ed25519PublicKeyB64`, the WC session metadata

## how to sign with WalletConnect

1. operations that need a WC signature enqueue a hardware-sign request via `enqueueHardwareSign({ vendor: 'walletconnect', kind: 'solanaTx' })`
2. popup opens the hardware-sign route, dispatches the sign request through the WC relay
3. phone wallet receives the request, you approve in-wallet
4. signature returns over the WC session, popup calls `resolveHardwareSign`

## how the x402 path uses WalletConnect

when `session.solanaWcAccount` is set, the x402 payment flow auto-routes to the WC signer (`x402-walletconnect-signer.ts`) instead of the ika MPC signer:

1. fetch interception detects a 402 + payment-required header
2. dispatcher (`x402-dispatch.ts`) decides between ika MPC and WC based on `session.solanaWcAccount`
3. WC-paired phone signs the versioned tx in its own Seed Vault / signer
4. ika MPC is bypassed entirely - the ed25519 key never leaves the phone

see [x402-payments.md](/library/user/x402-payments) for the full x402 flow

## how to remove a WalletConnect account

1. revoke the WC session in the phone wallet (this is the cleaner path, since the phone holds the session)
2. then call `removeHardwareAccount` with the account id to drop the local record

## notes

- WC adds a relay hop vs MWA local / remote, but unlocks wallets that don't support MWA (notably Phantom on iOS, where MWA is Android-only)
- if the WC session expires or is revoked phone-side, signing fails and chromatika surfaces an actionable error - re-pair to recover
- sessions persist in chromatika storage so a chrome restart doesn't force re-pair
