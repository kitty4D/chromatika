# Mobile Wallet Adapter 2.0 spec + reflector protocol

Mobile Wallet Adapter (MWA) 2.0 is Solana's spec for "how a desktop / web app talks to a Solana wallet on a phone". the local transport (Android intent dispatch) works only when both sides are on the same Android device. the **remote transport** uses a websocket reflector that bridges the desktop ↔ phone connection over the network.

spec: [solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html](https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html)

reflector subspec: [reflector-protocol](https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html#reflector-protocol)

## the protocol layers

```
[ MWA-2 application layer ]
  - methods: authorize, sign_messages, sign_transactions, sign_and_send_transactions
  - JSON-RPC 2.0-shaped messages

[ MWA-2 session layer ]
  - encrypted session via X25519 key exchange + AES-GCM
  - association URL carries pubkey + reflector params

[ transport layer ]
  - local: Android intent (solana-wallet:// scheme)
  - remote: WebSocket to reflector at wss://reflect.solanamobile.com/reflect
```

session-level encryption means the reflector (or any intermediate hop on the websocket) can't read the application-layer messages. it only forwards encrypted blobs.

## the association URL

at pairing time, the dapp generates an **association URL**:
```
solana-wallet:/v1/associate/<base64-encoded-association-data>
```

association data carries:
- ephemeral public key (X25519, used for the session key exchange)
- reflector hostname (where the wallet should connect to forward messages)
- reflector ID (the session topic on the reflector - both sides agree on this so they can reach each other through the relay)
- protocol version

the dapp shows this URL as a QR code on the desktop. the wallet scans the QR with the Seeker camera (or any MWA wallet's "scan link" input), parses the URL, connects to the reflector, completes the X25519 handshake.

## the reflector protocol

the reflector is a stateless message-forwarding server. clients connect via WebSocket, identified by a per-session topic:
```
wss://reflect.solanamobile.com/reflect?id=<session-topic>
```

both sides connect to the **same topic**. messages from one side are forwarded to the other. if one side disconnects, the reflector holds messages briefly waiting for reconnect.

```
[ desktop chromatika ]                         [ phone wallet (Seeker) ]
  open wss://reflect.solanamobile.com           scan QR, parse URL
  ←← topic, ephemeral pubkey ←←                 connect wss
  →→ X25519 handshake initiation →→             →→ X25519 response →→
  shared session key derived                    shared session key derived
  send encrypted authorize request
  ←← encrypted authorize response ←←
  ...
```

the reflector itself can't decrypt anything. session-layer crypto (X25519 + AES-GCM, all per-message) is end-to-end.

## the auth_token + persistence

after a successful `authorize` call, the wallet returns an `auth_token` that the dapp can store and use to **reauthorize** future sessions without re-pairing. chromatika persists `auth_token` plus the `reflectorHost` on the hardware vault record:

```jsonc
record.hardwareAccountId = '<id>';
record.hardwareVendor = 'mwa';
record.mwaTransport = 'remote';
record.mwaAuthToken = '<base64 token>';
record.mwaReflectorHost = 'reflect.solanamobile.com';
```

every subsequent sign:
1. desktop opens fresh WebSocket to the same reflector
2. sends `reauthorize { auth_token }`
3. wallet responds with a fresh authorize (or fails with `ERROR_AUTHORIZATION_FAILED` if the token is invalid)
4. on success, proceed to sign

so QR pairing happens **once** per device-pair. signing thereafter is QR-less.

## ERROR_AUTHORIZATION_FAILED handling

if the user uninstalls / reinstalls the wallet app, factory-resets the phone, or the wallet's session storage is cleared, the `auth_token` becomes invalid. chromatika handles:

```ts
try {
  await mwaSign(...);
} catch (e) {
  if (e.code === 'ERROR_AUTHORIZATION_FAILED') {
    // flip the MwaSigner state to needsRepair
    sessionState.mwaSigner.needsRepair = true;
    // surface "your Seeker pairing expired - re-pair via QR"
  }
}
```

re-pairing means generating a fresh association URL + new QR. user scans, fresh `auth_token` overwrites the old one.

## the can't-run-in-SW caveat

the MWA libraries (`@solana-mobile/mobile-wallet-adapter-protocol-web3js`) use:
- `WebSocket` API
- `window.btoa` / `atob` for base64
- DOM-related APIs in some code paths

the **service worker doesn't have these**. so MWA pairing + signing **must run in popup or side panel context**. chromatika does this in `SeekerConnect.tsx` and `MwaSigner` components.

## the host hard-coded constant

per CLAUDE.md:
- public reflector: `development.reflector.solanamobile.com`
- chromatika constant: `MWA_REMOTE_HOST_AUTHORITY = 'development.reflector.solanamobile.com'`

despite the spec calling reflectors "integrator-hosted" in theory, in practice all shipping wallets (Phantom Android, Solflare, Jupiter, Seeker) are tested against this Solana-Mobile-operated host. self-hosting a reflector causes silent UI freezes against most wallets even though the wire protocol works. **don't change this constant** unless the public host goes down.

a self-hosted Cloudflare-Workers reflector exists in `/reflector` (Durable Objects, ~150 lines TS) as a fallback. swap the constant to that hostname only if Solana Mobile's host goes down.

manifest CSP `connect-src *` covers wss today. tighten to an allowlist when the surface stabilizes.

## library

- `@solana-mobile/mobile-wallet-adapter-protocol-web3js` for `transact`, `startRemoteScenario`
- `@solana-mobile/mobile-wallet-adapter-protocol` for the lower-level type definitions
- internal: `wallet-extension/src/background/hardware/mwa-remote.ts` for the chromatika-facing shim
- internal: `wallet-extension/src/ui/hardware/SeekerConnect.tsx` for the QR pairing UI
- internal: `wallet-extension/src/ui/hardware/MwaSigner.tsx` for the sign popup

## related

- [mwa-local-android-intent.md](/library/tech/mwa-local-android-intent) - the same-device transport
- [mwa-remote-qr-pairing.md](/library/tech/mwa-remote-qr-pairing) - the desktop ↔ phone QR flow
- [wallet-signature-envelope.md](/library/tech/wallet-signature-envelope) - how MWA signatures unlock chromatika
- [ika-seed-solana-mwa-walletconnect.md](/library/tech/ika-seed-solana-mwa-walletconnect) - how MWA signatures derive the ika seed
