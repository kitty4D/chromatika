# WebHID (popup / side-panel only)

WebHID is the browser API for talking to USB Human Interface Devices. chromatika uses it for **Ledger** signing (any chain). critically, **WebHID requires a user gesture** and is **not available in the service worker** - which is why hardware-sign always opens a separate popup window where the gesture happens and the transport runs.

## the popup-only constraint

```ts
// SERVICE WORKER context - this fails:
const transport = await TransportWebHID.create();
// → SecurityError: Failed to execute 'create' on 'TransportWebHID': WebHID requires a window context

// POPUP / SIDE PANEL context - this works:
const transport = await TransportWebHID.create();
// → Transport instance
```

chromatika handles this by:

1. background enqueues a hardware-sign request (`enqueueHardwareSign(...)`)
2. background opens `chrome.windows.create({ url: 'index.html?hwsign=<id>', type: 'popup', ... })`
3. the popup runs `TransportWebHID.create()` (window context, has access)
4. user clicks "connect to Ledger" - that's the user gesture WebHID requires
5. WebHID prompts user to pick a Ledger device + grant permission
6. transport opens; popup runs the chain-specific signing call (`hw-app-eth.signTransaction`, etc.)
7. popup returns the signature via `resolveHardwareSign({ id, signature })`
8. background completes the original signing flow

## the user gesture rule

WebHID enforces "user gesture required" on:

- `navigator.hid.requestDevice(...)` - prompt the user to pick a device
- (subsequent calls with already-permitted devices don't require fresh gesture, but the **first** time a device is used after page load does)

popup is a fresh window context, so any button click in the popup counts as a user gesture for WebHID. chromatika's "Connect Ledger" button satisfies this.

## the transport library

chromatika uses `@ledgerhq/hw-transport-webhid`:

```ts
import TransportWebHID from "@ledgerhq/hw-transport-webhid";

const transport = await TransportWebHID.create();
const eth = new Eth(transport);
const signature = await eth.signTransaction(derivationPath, rawTxHex);
await transport.close();
```

`TransportWebHID.create()`:

1. opens a system dialog for the user to pick the Ledger device
2. once selected, returns a Transport object
3. subsequent calls (sign, derive address, etc.) reuse the transport

`transport.close()` releases the device for other apps. chromatika closes after each operation.

## the per-chain Ledger apps

Ledger devices run separate firmware "apps" per chain. user must open the right app on-device before chromatika's WebHID call:

- Ethereum app for EVM (`@ledgerhq/hw-app-eth`)
- Sui app for Sui (`@ledgerhq/hw-app-sui`)
- Solana app for Solana (`@ledgerhq/hw-app-solana`)
- Bitcoin app for BTC (`@ledgerhq/hw-app-btc`)

if the wrong app is open, the WebHID call returns an error from the device. chromatika surfaces "open the X app on your Ledger" with a retry option.

## the WebHID permission model

once granted, the permission **persists** for the chromatika origin:

- user is prompted on first connection
- subsequent connections from chromatika reuse the permission silently (no dialog)
- user can revoke via chrome's `chrome://settings/content/hidDevices` (cumbersome)
- uninstalling chromatika revokes the permission

this means after the first Ledger connection, chromatika can re-open the transport without re-prompting **as long as** the user gesture rule is satisfied (which it is in the popup).

## the side-panel alternative

Chrome 116+ introduced `chrome.sidePanel` - a persistent side panel for extensions. chromatika supports running its UI as a side panel (alongside the popup variant). WebHID works in the side panel context too because side panels have a window context.

so hardware-sign popups can be replaced by side-panel-driven flows in some cases. the canonical implementation today opens a separate popup for clarity (user knows "this thin window is just for hardware signing").

## the not-in-content-script note

content scripts run in an isolated world but have access to the page's `navigator`. could WebHID work there? **no**:

- content scripts don't have user-gesture context for the typical case (gestures are page-context, not extension-context)
- WebHID device selection requires extension origin permissions, not page origin

content scripts pass requests to the SW which dispatches to popups. don't try to drive WebHID directly from a content script.

## the buffer polyfill connection

`@ledgerhq/devices/hid-framing.js` and `bitcoinjs-lib` (used in BTC PSBT signing) use Node's `Buffer` global. browsers don't have it. `src/buffer-polyfill.ts` shims it via the `buffer` npm package. **must be imported as the first line of every entry point** (popup, side panel, background).

## what doesn't work

- **WebHID in service worker**: rejected by the API. always.
- **WebHID without user gesture**: first-time access fails. button click → call works
- **multiple Ledger apps simultaneously**: only one app can be open at a time. chromatika handles by routing the user "switch to X app" before the call

## library

- browser native `navigator.hid`, `navigator.hid.requestDevice`
- `@ledgerhq/hw-transport-webhid` for the chromatika-friendly Transport wrapper
- `@ledgerhq/hw-app-eth`, `hw-app-sui`, `hw-app-solana`, `hw-app-btc` for chain-specific signers
- internal: `wallet-extension/src/ui/hardware/` for the popup-side WebHID orchestration

## related

- [ledger-hw-app-libs.md](/library/tech/ledger-hw-app-libs) - per-app driver details
- [chrome-runtime-connect-trpc-port.md](/library/tech/chrome-runtime-connect-trpc-port) - how the popup talks back to the background
- [ledger.md](/library/user/ledger) (user-guides) - the user-facing flow
