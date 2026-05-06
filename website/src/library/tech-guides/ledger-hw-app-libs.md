# Ledger hw-app libraries

chromatika supports Ledger devices for EVM, Sui, Solana, and Bitcoin signing via Ledger's per-chain `hw-app-*` libraries. all wrap the same WebHID transport (`@ledgerhq/hw-transport-webhid`) and run in popup / side-panel context only.

## the library set

| package                            | version      | chain                     |
| ---------------------------------- | ------------ | ------------------------- |
| `@ledgerhq/hw-transport-webhid`    | ^6.35.1      | transport (USB HID)       |
| `@ledgerhq/hw-transport`           | 6.35.1       | base transport types      |
| `@ledgerhq/hw-app-eth`             | ^7.8.0       | EVM (eth, polygon, etc.)  |
| `@ledgerhq/hw-app-sui`             | 1.9.0        | Sui                       |
| `@ledgerhq/hw-app-solana`          | 7.10.1       | Solana                    |
| `@ledgerhq/hw-app-btc`             | ^10.21.1     | Bitcoin (segwit + legacy) |
| `@ledgerhq/devices/hid-framing.js` | (transitive) | HID frame protocol        |

## the transport pattern

```ts
import TransportWebHID from "@ledgerhq/hw-transport-webhid";

async function withTransport<T>(fn: (transport: Transport) => Promise<T>): Promise<T> {
  const transport = await TransportWebHID.create();
  try {
    return await fn(transport);
  } finally {
    await transport.close();
  }
}
```

`TransportWebHID.create()`:

- prompts user via WebHID dialog (first time only; subsequent connections silent if permission persists)
- requires user gesture (button click in popup)
- returns a `Transport` instance

`transport.close()` releases the device. always call in a `finally`.

## EVM signing

```ts
import Eth from "@ledgerhq/hw-app-eth";

await withTransport(async (transport) => {
  const eth = new Eth(transport);

  // get address (no on-device confirm by default)
  const { address, publicKey } = await eth.getAddress("44'/60'/0'/0/0", false);

  // sign transaction
  const sig = await eth.signTransaction("44'/60'/0'/0/0", rawTxHex);
  // sig = { v: '1c', r: '...', s: '...' }

  // sign personal message (EIP-191)
  const sigMsg = await eth.signPersonalMessage("44'/60'/0'/0/0", messageHex);

  // sign typed data v4
  const sigTyped = await eth.signEIP712HashedMessage(
    "44'/60'/0'/0/0",
    domainSeparatorHex,
    hashStructMessageHex
  );
});
```

note: `signEIP712HashedMessage` takes the **two component hashes** of EIP-712 (domain separator hash + struct hash), not the full preimage. ethers v6 `TypedDataEncoder.hashDomain()` and `hashStruct()` produce these.

Ledger displays the tx / message contents on the device for user confirmation. user presses confirm/reject buttons on the Ledger.

## Sui signing

```ts
import Sui from "@ledgerhq/hw-app-sui";

await withTransport(async (transport) => {
  const sui = new Sui(transport);

  const { address, publicKey } = await sui.getAddress("44'/784'/0'/0'/0'", false);

  const sig = await sui.signTransaction(
    "44'/784'/0'/0'/0'",
    txBytesWithIntent // 0x000000 || bcs(tx)
  );
  // sig = { signature: '<64-byte hex>' }
});
```

Sui Ledger app limitations are documented in `wallet-extension/docs/LEDGER_SUI_LIMITS.md`. firmware version + app version floors apply; chromatika surfaces version errors.

## Solana signing

```ts
import Solana from "@ledgerhq/hw-app-solana";

await withTransport(async (transport) => {
  const solana = new Solana(transport);

  const { address, publicKey } = await solana.getAddress("44'/501'/0'/0'");

  const sig = await solana.signTransaction("44'/501'/0'/0'", txBytes);
  // sig = { signature: <Buffer 64 bytes> }
});
```

note Solana derivation path is **4 segments** (`44'/501'/0'/0'`), all hardened.

## Bitcoin signing (PSBT)

```ts
import AppBtc from "@ledgerhq/hw-app-btc";

await withTransport(async (transport) => {
  const btc = new AppBtc({ transport, scrambleKey: "BTC" });

  // segwit address
  const { address } = await btc.getWalletPublicKey("84'/0'/0'/0/0", { format: "bech32" });

  // sign PSBT (segwit)
  const signedPsbt = await btc.signPsbtBuffer(psbtBufferIn, { startAt: 0, finalize: true });
});
```

`signPsbtBuffer` is the modern API (`hw-app-btc@10.x`). takes a PSBT, signs all inputs the device can sign, returns the updated PSBT. handles bech32 (P2WPKH segwit) + legacy paths. chromatika passes paths from BIP84 (`84'/0'/...`) for segwit and BIP86 (`86'/0'/...`) for taproot.

## the per-chain app on-device

Ledger devices run separate firmware "apps" per chain. user must open the right one before chromatika's `hw-app-*` calls succeed:

- "Ethereum" app for EVM
- "Sui" app for Sui
- "Solana" app for Solana
- "Bitcoin" app for BTC

if the wrong app is open, chromatika gets an "app not open" error from the device. surface "open the Ethereum app on your Ledger" with retry.

## the live-network stub

`@ledgerhq/live-network` ships a top-level `require("https")` that crashes inside the MV3 service worker (no Node `https` in the worker realm). chromatika replaces it with a local stub at `wallet-extension/stubs/ledger-live-network/` via `pnpm.overrides`. the stub provides default + `/cache` exports as no-ops since chromatika never invokes any of its functions (it's pulled in transitively by `@ledgerhq/hw-app-sui` -> `@mysten/ledgerjs-hw-app-sui` -> `ledger-trust-service` / `ledger-cal-service`, neither of which we call). the override is version-agnostic, so future Ledger lib bumps don't need a refresh.

## the buffer polyfill connection

`@ledgerhq/devices/hid-framing.js` uses Node's `Buffer` global. browsers don't have it. `src/buffer-polyfill.ts` shims via the `buffer` npm package. **import as the first line** of every entry point that touches Ledger code (popup, side panel).

## library

- per package above
- internal: `wallet-extension/src/ui/hardware/LedgerSigner.tsx` for the popup-side flow
- internal: `wallet-extension/src/background/hardware/ledger-derivation.ts` for derivation-path conventions

## related

- [webhid-popup-context.md](/library/tech/webhid-popup-context) - the WebHID transport
- [secp256k1-ecdsa.md](/library/tech/secp256k1-ecdsa), [taproot-schnorr.md](/library/tech/taproot-schnorr), [ed25519-eddsa.md](/library/tech/ed25519-eddsa) - underlying signature math
- [ledger.md](/library/user/ledger) (user-guides) - the user-facing flow
