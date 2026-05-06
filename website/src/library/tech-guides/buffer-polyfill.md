# `buffer-polyfill.ts` (Node Buffer in browser)

several chromatika dependencies use Node's `Buffer` global, which doesn't exist in browser environments. `wallet-extension/src/buffer-polyfill.ts` shims `globalThis.Buffer` via the `buffer` npm package so those libs work. **must be imported as the first line** of every entry point.

## who needs it

| dep                                | why                                                        |
| ---------------------------------- | ---------------------------------------------------------- |
| `@ledgerhq/devices/hid-framing.js` | uses `Buffer.from`, `Buffer.alloc` for HID frame parsing   |
| `bitcoinjs-lib`                    | uses `Buffer` extensively for tx serialization, script ops |
| `@solana/web3.js` 1.x              | uses `Buffer` for some serialization paths                 |

attempting to use these without the polyfill causes runtime errors:

```
ReferenceError: Buffer is not defined
```

at the first call that references `Buffer`.

## the shim

```ts
// wallet-extension/src/buffer-polyfill.ts
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}
```

`buffer` (lowercase, the npm package) provides a browser-compatible `Buffer` implementation. assigning to `globalThis.Buffer` makes it accessible as `Buffer.from(...)` etc. without explicit imports.

## the import-order rule

```ts
// popup entry point: src/popup/main.tsx
import "../buffer-polyfill"; // FIRST LINE - before any other import
import "./styles.css";
import { createRoot } from "react-dom/client";
import App from "./App";
// ... rest
```

other imports might transitively require Buffer at module-load time (e.g. importing `bitcoinjs-lib` runs side-effecty top-level code that touches `Buffer`). the polyfill must be active before that happens.

if you forget the polyfill on a new entry point and import a Buffer-using lib, you get the runtime error at startup.

## entry points that need it

- `src/popup/main.tsx` - popup UI
- `src/side-panel/main.tsx` - side panel UI
- `src/background/index.ts` - service worker
- (any new entry point that loads code paths touching Ledger / Bitcoin / Solana 1.x)

## the vite globalThis define

`vite.config.ts` also defines `global: 'globalThis'` for packages that reference `global` (Node convention for `globalThis`):

```ts
// vite.config.ts
export default defineConfig({
  define: {
    global: "globalThis",
  },
});
```

different from Buffer - `global` is a separate Node-ism that some libs use (especially older crypto libs). the define replaces `global` with `globalThis` at bundle time so those references resolve correctly.

## why not just use Uint8Array everywhere

```ts
const buf = new Uint8Array([0x01, 0x02, 0x03]); // works in browsers, no polyfill
```

modern crypto libs (`@noble/hashes`, `@noble/curves`, `@scure/bip39`) use `Uint8Array` natively - no Buffer dependency. chromatika's own code prefers `Uint8Array`. Buffer is only there for **transitive** deps that pre-date the modern conventions (Ledger devices, bitcoinjs-lib, older Solana SDK).

if those deps eventually drop Buffer (e.g. by migrating to noble-style libs internally), the polyfill becomes unnecessary. for now, it's load-bearing.

## library

- `buffer` npm package (browser Buffer impl)
- internal: `wallet-extension/src/buffer-polyfill.ts`
- vite config: `wallet-extension/vite.config.ts`

## related

- [bitcoinjs-lib-usage.md](/library/tech/bitcoinjs-lib-usage) - the largest Buffer-using consumer
- [ledger-hw-app-libs.md](/library/tech/ledger-hw-app-libs) - HID framing uses Buffer
