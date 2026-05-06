# WalletConnect v2 (`@walletconnect/sign-client`)

WalletConnect v2 is a relay-based protocol that lets a desktop app pair with a phone wallet. chromatika uses WalletConnect specifically for the **x402 Solana payment** path (Seeker / Phantom / Solflare phone signs) and as a generic hardware-sign vendor (`vendor: 'walletconnect'`). like MWA, it relies on a relay (WalletConnect Cloud or self-hosted) - chromatika uses WalletConnect Cloud's default relay.

## the protocol layers

```
[ application layer: JSON-RPC method calls (eth_sign, solana_signTransaction, etc.) ]
[ session layer: encrypted via X25519 + ChaCha20-Poly1305 ]
[ relay transport: WebSocket to wss://relay.walletconnect.com ]
```

similar to MWA's reflector but with different wire format + crypto primitive (ChaCha20 instead of AES-GCM).

## the deps

```jsonc
"@walletconnect/sign-client": "^2.23.9"
"@walletconnect/utils": "^2.23.9"
```

## the project id

WalletConnect requires a per-app `projectId` for relay access:

```ts
const signClient = await SignClient.init({
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID,
  metadata: {
    name: "Chromatika",
    description: "Chromatika browser extension wallet",
    url: "chrome-extension://<chromatika-id>",
    icons: ["data:image/svg+xml;base64,..."],
  },
});
```

`projectId` is registered at [cloud.walletconnect.com](https://cloud.walletconnect.com). free tier covers chromatika's usage.

## the pairing flow

```ts
// 1. propose a session
const { uri, approval } = await signClient.connect({
  requiredNamespaces: {
    solana: {
      methods: ["solana_signTransaction", "solana_signMessage"],
      chains: ["solana:mainnet", "solana:devnet"],
      events: [],
    },
  },
});

// 2. render uri as QR code, user scans with phone wallet's WC modal
//    or paste uri into the wallet's "scan link" input

// 3. wait for the user to approve in the wallet
const session = await approval();
// session = { topic, namespaces, expiry, ... }

// 4. extract the address(es)
const account = session.namespaces.solana.accounts[0];
// e.g. "solana:mainnet:<base58-address>"
```

## the sign request

```ts
const result = await signClient.request({
  topic: session.topic,
  chainId: "solana:mainnet",
  request: {
    method: "solana_signTransaction",
    params: { transaction: base64SerializedTx },
  },
});
// result = { signature: '<base58-or-base64>' }
```

the phone wallet pops a UI for the user to approve. result returns over the relay.

## the x402 dispatcher integration

chromatika dispatches x402 Solana payments based on whether `session.solanaWcAccount` is set:

```ts
// in x402-dispatch.ts
const signer = session.solanaWcAccount
  ? x402WalletConnectSign(...)    // route through WC
  : x402SolanaIkaSign(...);        // route through ika MPC (default)
```

WC path: the phone wallet (Seeker / Phantom / Solflare) signs in its own Seed Vault. the ed25519 key never leaves the phone. ika MPC bypassed entirely. this is the cleanest mitigation against the "402-bridge breach" class - even a fully compromised chromatika can't produce signatures because the key is on the phone.

## the session lifecycle

WC sessions live until **revoked phone-side** or until expiry (default 7 days). chromatika persists session metadata to skip re-pair on chrome restart:

```jsonc
record.hardwareVendor = 'walletconnect';
record.hardwareChain = 'solana';
record.wcSessionTopic = '<topic>';
record.wcAccount = 'solana:mainnet:<base58>';
record.wcSessionExpiryMs = ...;
```

on chrome restart, chromatika reinitializes `SignClient` and the session is automatically resumed (the topic is in the WC SDK's session store).

## the disconnect

```ts
await signClient.disconnect({
  topic: session.topic,
  reason: { code: 6000, message: "User disconnected" },
});
```

after disconnect:

1. the phone wallet's WC sessions list shows it as ended
2. chromatika removes `wcSessionTopic` from the vault record
3. subsequent sign attempts fail; user must re-pair

if the user revokes phone-side first (e.g. via Phantom's WC sessions UI), chromatika's session goes invalid silently. next sign attempt fails; chromatika surfaces "WC session expired - re-pair" and removes the stale topic.

## why WC alongside MWA

different wallets support different protocols:

- **Seeker**: built-in MWA (reflector) + WC v2
- **Phantom Android**: MWA + WC
- **Phantom iOS**: WC only (no MWA on iOS)
- **Solflare**: MWA + WC
- **Jupiter**: MWA + WC

chromatika supports both transports so users can pair with whichever protocol their phone wallet exposes. for iOS users especially, WC is the only option (since MWA Android intent doesn't work on iOS).

## EVM and BTC support

WC v2 supports EVM (`eip155:`) and Bitcoin (`bip122:`) namespaces. chromatika **doesn't expose** these today - WC integration is Solana-focused for x402. when chromatika adds EVM hardware-via-WC or BTC-via-WC paths, the same `@walletconnect/sign-client` machinery applies; just register additional `requiredNamespaces`.

## library

- `@walletconnect/sign-client` for the SDK
- `@walletconnect/utils` for shared utilities (encoding, error codes)
- internal: `wallet-extension/src/background/hardware/walletconnect.ts` for chromatika-facing wrappers

## related

- [mwa-2-spec-and-reflector.md](/library/tech/mwa-2-spec-and-reflector) - the analogous Solana-Mobile protocol
- [x402-solana-tx-build.md](/library/tech/x402-solana-tx-build) - what gets signed via WC for x402
- [walletconnect.md](/library/user/walletconnect) (user-guides) - the user-facing flow
- [ika-seed-solana-mwa-walletconnect.md](/library/tech/ika-seed-solana-mwa-walletconnect) - the seed derivation
