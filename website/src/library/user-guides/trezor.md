# how to use a Trezor hardware wallet

pair a Trezor device via `@trezor/connect-web` and use it as a hardware account in chromatika for EVM message + typed-data + transaction signing, plus Solana transaction signing. **chromatika never asks for your seed phrase from the device** - all signing stays on-device.

## prerequisites

- Trezor Model One or Model T with current firmware
- chromatika manifest CSP allows `frame-src https://connect.trezor.io` (already shipped)
- the pairing must run from popup / side-panel (Trezor Connect uses a hosted iframe; the service worker cannot drive it)
- your Chromatika vault is unlocked

## options at a glance

- **chains supported today**: EVM (message, typed data, tx), Solana (tx)
- **chains not supported**: Bitcoin PSBT (Trezor needs decomposed UTXO inputs - chromatika throws an actionable error pointing at Ledger; tracked as future), Sui (Trezor Connect doesn't expose Sui)

## how to pair a Trezor account

1. plug the device in, unlock with your PIN
2. trigger the Trezor Connect account-discovery flow - the hosted iframe walks through device authorization
3. submit `addHardwareAccount` with: `vendor: 'trezor'`, `chain` (`evm` or `solana`), `derivationPath`, `address`, and `ed25519PublicKeyB64` for Solana

## how to sign with a Trezor

1. operations that require signing enqueue a hardware-sign request and open the popup at `index.html?hwsign=ID`
2. popup calls `getHardwareSignRequest` with id, drives Trezor Connect (`TrezorConnect.ethereumSignMessage` / `signTypedData` / `signTransaction` / `solanaSignTransaction`)
3. confirm on the device
4. popup calls `resolveHardwareSign` with the signature, or `rejectHardwareSign` if cancelled

## how to remove a Trezor account

1. `removeHardwareAccount` with the account `id`

## notes

- attempting Bitcoin sign on a Trezor account throws with an actionable error message pointing the user at Ledger today
- Sui is unsupported by Trezor Connect at the protocol level - chromatika does not pretend otherwise
- if the Trezor Connect iframe fails to load, check that `https://connect.trezor.io` is reachable and that the CSP `frame-src` allows it
