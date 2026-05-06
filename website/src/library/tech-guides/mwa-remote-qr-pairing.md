# MWA remote transport (desktop ↔ phone QR pairing)

MWA remote transport bridges chromatika running on a **desktop** browser with a Solana wallet on a **phone**. uses the Solana Mobile reflector (`wss://development.reflector.solanamobile.com/reflect`) as a relay. the user scans a QR code on the desktop with the Seeker camera (or any MWA-wallet's "scan link" input), and from then on signing flows are QR-less.

## the pairing

```
desktop chromatika                                phone wallet (Seeker)

1. SeekerConnect.tsx: startRemoteScenario()
2. lib opens wss://development.reflector.solanamobile.com/reflect?id=<topic>
3. lib generates association URL:
   solana-wallet:/v1/associate/<base64-data>
4. UI renders this URL as a QR code

                                                  5. user scans QR with Seeker camera
                                                  6. Seeker parses URL, connects to same reflector
                                                  7. X25519 handshake completes
                                                  8. session key derived

9. lib sends authorize request (encrypted)
                                                  10. Seeker shows authorize prompt
                                                  11. user approves
                                                  12. Seeker returns authorize response with auth_token
13. desktop receives, derives address +
    persists auth_token to vault record
```

## why remote when local works

`@solana-mobile/mobile-wallet-adapter-protocol-web3js` `startRemoteScenario()` is the entry point. the underlying transport opens a WebSocket. the reflector forwards encrypted messages between the two sides without seeing plaintext.

reasons to use remote:

- **desktop chromatika**: Android intents don't work; remote is the only option
- **iOS phone**: Android intent system isn't available; iOS wallets advertise themselves via custom URL schemes that work in browsers, but full iOS MWA is younger; remote is most robust

## the wss restriction in SW

the MWA library uses `window.btoa`, `atob`, and other window-context APIs. **service workers don't have these**. so `startRemoteScenario` must run in **popup or side-panel** context.

chromatika's `SeekerConnect.tsx` (popup component) drives the pairing. on success, it persists state to chrome.storage.local via tRPC, and the SW picks it up for subsequent ops.

## the persistent auth_token

```jsonc
record.hardwareVendor = 'mwa';
record.mwaTransport = 'remote';
record.mwaAuthToken = '<base64 token>';
record.mwaReflectorHost = 'development.reflector.solanamobile.com';
record.address = '<base58 phone wallet address>';
```

every subsequent sign:

1. open fresh wss to the same reflector with the persisted topic
2. lib sends `reauthorize` with the persisted `auth_token`
3. Seeker reauthorizes silently (no UI on phone if the token is still valid)
4. dispatch the sign request
5. Seeker shows sign UI on phone
6. user approves
7. signature returns through the reflector

QR appears **only at initial pairing** (and on re-pair after `ERROR_AUTHORIZATION_FAILED`).

## the IKA_USK_DERIVATION_MESSAGE sign

at pairing, chromatika asks the wallet to sign `IKA_USK_DERIVATION_MESSAGE` (`'ika.chromatika.user-share-encryption-key.v1'`). the resulting 64-byte ed25519 signature drives:

1. the ika seed: `keccak256(signature || u32_le(0))` → 32-byte seed for `UserShareEncryptionKeys`
2. the in-extension fee-payer keypair (separate index): `keccak256(signature || u32_le(1))` → seed for `Keypair.fromSeed`

determinism: same wallet on a different device produces the same signature → same ika seed → same dWallet → restore-on-new-machine works without seed phrase.

see [ika-seed-solana-mwa-walletconnect.md](/library/tech/ika-seed-solana-mwa-walletconnect) for the full derivation.

## the reflector hostname

`MWA_REMOTE_HOST_AUTHORITY = 'development.reflector.solanamobile.com'`

despite the MWA 2.0 spec describing reflectors as "integrator-hosted", in practice all shipping wallets are tested against this Solana-Mobile-operated host. self-hosted reflectors cause silent UI freezes (wallets fail to connect or hang at handshake) even though the wire protocol works correctly.

a self-hosted Cloudflare-Workers reflector exists in `/reflector` of the chromatika repo as a fallback (Durable Objects, ~150 lines TS). swap the constant only if the Solana-Mobile host goes down.

## the CSP relaxation

manifest CSP currently has `connect-src *` to allow wss to any reflector. when the surface stabilizes (only one reflector host needed), tighten to an allowlist:

```jsonc
"connect-src": "'self' wss://development.reflector.solanamobile.com https://api.mainnet-beta.solana.com ..."
```

## sign-request flow

```ts
async function mwaRemoteSign(record, message: Uint8Array) {
  const transport = await startRemoteScenario({
    reflectorHost: record.mwaReflectorHost,
    sessionTopicSeed: deriveTopicFromAuthToken(record.mwaAuthToken),
  });

  const result = await transport.transact(async (wallet) => {
    // reauthorize silently
    await wallet.reauthorize({ auth_token: record.mwaAuthToken });

    // sign
    const signed = await wallet.signMessages({
      addresses: [record.address],
      payloads: [message],
    });

    return signed;
  });

  return result.signedPayloads[0]; // 64-byte ed25519 signature
}
```

## error: needsRepair

if the wallet returns `ERROR_AUTHORIZATION_FAILED`:

```ts
sessionState.mwaSigner.needsRepair = true;
```

the next sign attempt surfaces "Seeker pairing expired - re-pair to continue". user clicks re-pair, fresh QR is generated.

## library

- `@solana-mobile/mobile-wallet-adapter-protocol-web3js` `startRemoteScenario`, `transact`
- `qrcode` for rendering the association URL as QR
- internal: `wallet-extension/src/background/hardware/mwa-remote.ts` for the orchestration layer
- internal: `wallet-extension/src/ui/hardware/SeekerConnect.tsx` for the pairing popup

## related

- [mwa-2-spec-and-reflector.md](/library/tech/mwa-2-spec-and-reflector) - the underlying spec
- [mwa-local-android-intent.md](/library/tech/mwa-local-android-intent) - the same-device alternative
- [seeker-remote.md](/library/user/seeker-remote) (user-guides) - the user-facing flow
- [ika-seed-solana-mwa-walletconnect.md](/library/tech/ika-seed-solana-mwa-walletconnect) - the seed derivation
- [wallet-signature-envelope.md](/library/tech/wallet-signature-envelope) - how the signature unlocks chromatika
