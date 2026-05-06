# Trezor Connect (`@trezor/connect-web`)

chromatika supports Trezor devices via Trezor's hosted iframe at `https://connect.trezor.io`. the iframe handles WebUSB / WebHID transport + UI prompts; chromatika passes JSON-RPC-style requests through `@trezor/connect-web`. supports EVM (message + tx + typed data) and Solana (tx). does **not** support Sui or Bitcoin PSBT today.

## why an iframe (not direct WebHID)

Trezor's design is to host a single TypeScript SDK at `connect.trezor.io` that all dapps embed. benefits:

- single source of truth for device firmware compatibility
- centralized UI for confirmations + passphrase prompts
- no need for each dapp to handle USB device dialogs

trade-off: the iframe runs cross-origin, so chromatika has to communicate via `postMessage` and trust Trezor's hosted code.

## the CSP allowance

manifest CSP includes:

```jsonc
"frame-src": "https://connect.trezor.io"
```

without this, the iframe fails to load. chromatika's manifest already has it.

## the connection

```ts
import TrezorConnect from "@trezor/connect-web";

// initialize once
TrezorConnect.init({
  manifest: {
    appUrl: "chrome-extension://<chromatika-id>",
    email: "support@chromatika.example",
  },
  lazyLoad: true, // don't load the iframe until first use
  popup: false, // use the embedded iframe, not a separate popup
});
```

`init` lazily loads `https://connect.trezor.io/9/popup.html` into an iframe in the chromatika popup. subsequent calls go through the iframe via `postMessage`.

## the calls

```ts
// EVM message sign
const result = await TrezorConnect.ethereumSignMessage({
  path: "m/44'/60'/0'/0/0",
  message: "Hello, world",
  hex: false,
});
// result.payload = { signature: '0x...' }

// EVM typed data v4
const result = await TrezorConnect.ethereumSignTypedData({
  path: "m/44'/60'/0'/0/0",
  data: { domain, types, primaryType, message },
  metamask_v4_compat: true,
});

// EVM transaction
const result = await TrezorConnect.ethereumSignTransaction({
  path: "m/44'/60'/0'/0/0",
  transaction: {
    to: "0x...",
    value: "0x...",
    data: "0x",
    chainId: 1,
    nonce: "0x...",
    gasLimit: "0x...",
    maxFeePerGas: "0x...",
    maxPriorityFeePerGas: "0x...",
  },
});

// Solana transaction
const result = await TrezorConnect.solanaSignTransaction({
  path: "44'/501'/0'/0'",
  serializedTx: txBytes,
});
```

each call:

1. chromatika invokes the SDK method
2. SDK posts to its iframe
3. iframe handles USB transport, displays confirm UI
4. user confirms on device
5. iframe returns result
6. chromatika receives `{ success: bool, payload: ... }`

## what doesn't work

### Bitcoin PSBT

Trezor wants **decomposed UTXO inputs** (raw `TxInputType[]` / `TxOutputType[]` with reference txs), not a raw PSBT blob. chromatika's BTC code uses PSBT. converting PSBT → Trezor's expected shape requires:

- decoding the PSBT
- fetching reference txs (`refTxs`) for each input
- converting to `TxInputType[]` / `TxOutputType[]`
- calling `TrezorConnect.signTransaction` with those

this isn't implemented today. attempting Trezor BTC sign throws with an actionable error pointing at Ledger.

### Sui

Trezor Connect doesn't expose Sui signing at the protocol level. no Sui app on Trezor firmware. chromatika doesn't pretend - Trezor Sui isn't an option.

## the EVM personal_sign convention

note: chromatika's main EVM signing path uses **ika MPC** (the dWallet path). Trezor is a hardware-account path - the user has imported a Trezor account via `addHardwareAccount({ vendor: 'trezor', ... })`. signing routes through Trezor's iframe, not ika.

so when a dapp calls `personal_sign` on an account that's a Trezor hardware account, chromatika's hardware-sign popup runs `TrezorConnect.ethereumSignMessage`. user confirms on Trezor, signature returns.

## the EVM derivation path quirk

chromatika uses BIP44 path `m/44'/60'/0'/0/0` for EVM. some legacy MetaMask extensions used `m/44'/60'/0'/0` (one segment less). Trezor accepts both but the addresses differ. chromatika sticks with the standard 5-segment form.

## library

- `@trezor/connect-web` ^9.7.3 (latest 9.x)
- internal: `wallet-extension/src/ui/hardware/trezor-connect-web.ts` for SDK init wrapper
- internal: `wallet-extension/src/ui/hardware/TrezorSigner.tsx` for the popup-side flow

## related

- [webhid-popup-context.md](/library/tech/webhid-popup-context) - the WebHID notes (Trezor uses WebUSB inside iframe rather than WebHID, but same popup-context constraint)
- [trezor.md](/library/user/trezor) (user-guides) - the user-facing flow
- [ledger-hw-app-libs.md](/library/tech/ledger-hw-app-libs) - the alternative hardware path
