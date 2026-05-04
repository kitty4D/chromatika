# how to use a Ledger hardware wallet

pair a Ledger device over WebHID and use it as a hardware account inside chromatika. Ledger covers EVM (`personal_sign`, transactions, EIP-712 typed data), Sui transactions, Solana (transactions and off-chain messages), and Bitcoin PSBT signing. **chromatika never asks for your seed phrase or private key from the device** - all signing stays on-device.

## prerequisites

- Ledger device (Nano S Plus, Nano X, etc.) running compatible firmware
- the chain-specific app installed on the device (Ethereum app, Sui app, Solana app, Bitcoin app)
- a USB connection or compatible WebHID-supported transport
- the pairing must run from a popup or side-panel context (WebHID requires a user gesture and is **not** available in the service worker)
- your Chromatika vault is unlocked

## options at a glance

- **chains supported**: EVM, Sui, Solana, Bitcoin (P2WPKH bech32 + legacy paths)
- **derivation path**: standard BIP44 paths per chain (e.g. `m/44'/60'/0'/0/0` for EVM)
- **add as account**, not as primary vault root - the dWallet Vault root stays mnemonic-backed; Ledger is a hardware **account** sibling

## how to pair a Ledger account

1. unlock the Ledger and open the chain app you want to use
2. trigger the WebHID pairing flow (browser asks you to grant access to the device)
3. submit `addHardwareAccount` with: `vendor: 'ledger'`, `chain` (`evm` / `sui` / `solana` / `btc`), `derivationPath`, the device's `address`, and the `ed25519PublicKeyB64` if applicable (Sui / Solana)
4. account shows up in `getHardwareAccounts`

## how to sign with a Ledger

signing is initiated by chromatika operations (sends, dapp tx approval, message signing) when the active account for the relevant chain is a Ledger hardware account. the flow:

1. wallet enqueues the sign request and opens a hardware-sign popup at `index.html?hwsign=ID`
2. popup calls `getHardwareSignRequest` with the id to read the message / tx
3. popup runs `TransportWebHID.create()` and the matching `hw-app-*` library to ask the device to sign
4. you confirm on the device
5. popup calls `resolveHardwareSign` with the returned signature - chromatika finishes the broadcast / dapp response
6. cancel via `rejectHardwareSign` with a reason if you back out

## how to remove a Ledger account

1. call `removeHardwareAccount` with the account `id` from `getHardwareAccounts`
2. the account is dropped from the local list; on-chain state is untouched

## chain-specific notes

- **EVM** (`personal_sign`, tx, EIP-712 typed data): standard `hw-app-eth` paths
- **Sui** (`suiTx`): app + firmware floors documented in [LEDGER_SUI_LIMITS.md](/library/user/ledger_sui_limits) - if Ledger throws an unsupported-tx error, check version
- **Solana** (tx + off-chain message): standard `hw-app-solana`
- **Bitcoin PSBT**: `hw-app-btc@10.x` `signPsbtBuffer` for bech32 + legacy paths

## notes

- WebHID lives in popup / side-panel only. the service worker cannot drive it - that's why hardware signing always opens a separate popup window
- Ledger gives you signatures over data, never over secrets. if any flow asks you to type a Ledger seed, it's wrong - reject it
- the Ledger app on the device must be the right one for the chain you're signing for. switching apps mid-flow may cancel the pending request
- two `@ledgerhq/live-network` versions are pinned + patched in chromatika today (`2.0.19` + `2.4.3`); reconciling these is a future cleanup task and should not affect users
