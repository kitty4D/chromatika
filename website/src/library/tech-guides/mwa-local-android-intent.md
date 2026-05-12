# MWA local transport (Android intent)

Mobile Wallet Adapter local transport works **only when chromatika and the wallet app are on the same Android device**. uses the Android intent system (`solana-wallet://` URI scheme) to launch the wallet, which signs and returns the result via the same intent. no reflector, no network round-trip.

## the transport flow

```
[chromatika running in Android Chrome]
  1. transact() called from popup / side-panel
  2. lib generates a solana-wallet:// URI with the request payload
  3. browser dispatches Android intent with the URI
  4. Android sees the registered handler (Seeker built-in, Phantom Android, Solflare, Jupiter)
  5. user picks if multiple wallets installed
  6. wallet app launches, displays the request, user approves
  7. wallet builds the response, dispatches back via intent (same URI scheme + result extras)
  8. chromatika receives, parses, returns to caller
```

session crypto (X25519 + AES-GCM) is the same as remote MWA (see [mwa-2-spec-and-reflector.md](/library/tech/mwa-2-spec-and-reflector)). the only difference is the transport hop: Android intent instead of WebSocket reflector.

## the UA gate

chromatika only surfaces the local-MWA option when the user agent matches Android:
```ts
const isAndroid = /Android/i.test(navigator.userAgent);
const showMwaLocal = isAndroid;
const showMwaRemote = !isAndroid;
```

on desktop / iOS, MWA local won't work (the intent dispatch has nothing to handle it), so the UI shows the remote QR option instead.

## the lib call

```ts
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';

const result = await transact(async (wallet) => {
  // authorize
  const auth = await wallet.authorize({
    cluster: 'mainnet-beta',
    identity: { name: 'Chromatika', uri: 'chrome-extension://<id>', icon: '...' },
  });
  // store auth.account, auth.auth_token
  return auth;
});
```

`transact()` handles:
- generating the association URL with intent scheme
- launching the intent (browser handles automatically)
- waiting for the response intent
- decrypting the response with the session key

## the Android Chromium quirk

on Android Chromium browsers (Chrome, Edge, Brave), web pages can dispatch intents via:
```
window.location.href = 'solana-wallet://v1/associate/...';
```

or via a more structured form:
```
const link = document.createElement('a');
link.href = 'solana-wallet://v1/associate/...';
link.click();
```

the MWA lib internally uses one of these mechanisms. either way, chromatika doesn't construct the intent URI by hand - it calls `transact` and lets the lib handle it.

## sign request flow

after pairing, sign requests use the same `transact` pattern:
```ts
const result = await transact(async (wallet) => {
  await wallet.reauthorize({ auth_token });
  const signed = await wallet.signTransactions({
    transactions: [base64SerializedTx],
  });
  return signed;
});
```

each `transact` call is one full intent round-trip. for batched signing (multiple txs), pass them all in one `signTransactions` call to avoid multiple intent dispatches.

## the dispatch on `mwaTransport`

chromatika's hardware-sign popup checks `record.mwaTransport`:
```ts
if (record.hardwareVendor === 'mwa' && record.mwaTransport === 'local') {
  await mwaLocalSign(record, message);
} else if (record.hardwareVendor === 'mwa' && record.mwaTransport === 'remote') {
  await mwaRemoteSign(record, message);
}
```

records are persisted with `mwaTransport: 'local'` at pairing time. switching transports requires re-pairing.

## what doesn't work

- **desktop Chromium**: `solana-wallet://` intent dispatch silently fails (no handler). use remote transport
- **iOS Safari**: MWA spec-level support exists but the intent ergonomics differ; chromatika doesn't expose iOS local-MWA today
- **inside extension popup on Android**: the intent dispatch should work because popups are still web pages, but chromatika has tested primarily with the Android Chrome side-panel context

## library

- `@solana-mobile/mobile-wallet-adapter-protocol-web3js` `transact`
- internal: `wallet-extension/src/background/hardware/mwa-local.ts` for chromatika-facing wrappers
- internal: `wallet-extension/src/ui/hardware/MwaSigner.tsx` for the sign UI

## related

- [mwa-2-spec-and-reflector.md](/library/tech/mwa-2-spec-and-reflector) - the underlying spec
- [mwa-remote-qr-pairing.md](/library/tech/mwa-remote-qr-pairing) - the desktop ↔ phone alternative
- [seeker-local.md](/library/user/seeker-local) (user-guides) - the user-facing flow
