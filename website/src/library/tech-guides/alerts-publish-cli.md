# `publish-alert.mjs` CLI

the offline tool a publisher uses to generate keypairs, sign alerts, and build the feed JSON the wallet polls. zero npm deps beyond `@noble/ed25519` + `@noble/hashes`. runs anywhere with node 18+. the canonical JSON serializer matches `alerts-types.ts` exactly so signatures round-trip.

lives at `wallet-extension/scripts/publish-alert.mjs`. five sub-commands.

## `--gen-key`

generate a fresh ed25519 keypair for production publishing.

```sh
node scripts/publish-alert.mjs --gen-key
```

output:
```
generated keypair
  pub (b64): +Qzgt7hrnGc94nPyvFFmQuv+EzRxCBvYsCN0XHHkWQA=
  priv (b64): <64-byte b64>

next steps:
  1. save priv (b64) somewhere safe - hardware wallet seed, 1Password, etc.
     this is the SIGNING KEY. anyone with it can sign alerts that wallets accept.
  2. paste pub (b64) into wallet-extension/src/background/alerts/alerts-publishers.ts
     under BUNDLED_PUBLISHERS, with a label and addedAt date
  3. bump BUNDLED_PUBLISHERS_REVISION so caches re-verify against the new allowlist
  4. ship a chromatika release that includes the new publisher
  5. start using `sign --priv <b64>` to issue alerts
```

implementation:
```js
const priv = ed.utils.randomPrivateKey();   // 64 bytes (32-byte seed + derived 32-byte priv state)
const pub = await ed.getPublicKeyAsync(priv);
console.log('  pub (b64):', base64Encode(pub));
console.log('  priv (b64):', base64Encode(priv));
```

privkey is **64 bytes** (noble/ed25519 v3 returns the full canonical RFC 8032 secret which includes the secret seed + derived state). the wallet only needs the 32-byte pubkey.

## `--gen-dev-key`

derive the deterministic dev publisher keypair from the seed `chromatika-dev-publisher-v0`. anyone running this command produces the same keypair. used for hackathon demos where the bundled `PLACEHOLDER_DEV_PUBLISHER_PUBKEY_B64` is the deterministic pubkey from this seed.

```sh
node scripts/publish-alert.mjs --gen-dev-key
```

output (always identical):
```
deterministic dev publisher
  pub (b64): +Qzgt7hrnGc94nPyvFFmQuv+EzRxCBvYsCN0XHHkWQA=
  priv (b64): <derived from seed 'chromatika-dev-publisher-v0'>

note: this keypair is DETERMINISTIC and BUNDLED into the wallet's allowlist.
      for production, generate a fresh key with --gen-key.
```

implementation:
```js
const SEED = new TextEncoder().encode('chromatika-dev-publisher-v0');
const priv = sha512(SEED).slice(0, 32);   // 32-byte seed for ed25519
const pub = await ed.getPublicKeyAsync(priv);
```

note: the dev seed isn't a real RFC 8032 seed - it's a deterministic 32 bytes derived from a fixed string. fine for dev demos, definitely not fine for production.

## `sign --priv <b64> --in <unsigned.json> --out <signed.json>`

sign an unsigned alert envelope.

```sh
node scripts/publish-alert.mjs sign \
  --priv <base64 64-byte privkey> \
  --in unsigned.json \
  --out signed.json
```

input file (unsigned envelope - publisher fills `id`, `severity`, etc. but not `signatureB64`):
```json
{
  "v": 1,
  "id": "uniswap-clone-2026-04-29",
  "severity": "critical",
  "timestampMs": 1712345678000,
  "expiresAtMs": 1712950478000,
  "affectedDomains": ["evilsite.io"],
  "affectedChains": ["evm"],
  "titleShort": "phishing uniswap clone",
  "bodyLong": "...",
  "publisherKeyB64": "<expected-pubkey-b64>"
}
```

output:
- writes signed envelope to `--out` path
- includes `signatureB64` field
- echoes `wrote signed alert to <path>` on stdout

implementation:
```js
const unsigned = JSON.parse(fs.readFileSync(args.in, 'utf-8'));

// canonical bytes (key-sorted, undefined dropped, no whitespace)
const canonical = canonicalAlertBytes(unsigned);

const priv = base64Decode(args.priv);
const sig = await ed.signAsync(canonical, priv.slice(0, 32));   // first 32 bytes is the seed

// optional: verify against the expected pubkey to catch input errors
const pub = await ed.getPublicKeyAsync(priv.slice(0, 32));
const expectedPub = unsigned.publisherKeyB64;
if (base64Encode(pub) !== expectedPub) {
  console.error('publisherKeyB64 in input does not match privkey-derived pubkey');
  process.exit(1);
}

const signed = { ...unsigned, signatureB64: base64Encode(sig) };
fs.writeFileSync(args.out, JSON.stringify(signed, null, 2));
```

note the `canonicalAlertBytes` here matches the wallet's verifier exactly - same key sorting, same JSON output, same UTF-8 encoding. mismatch would mean the wallet rejects with `bad-signature` even though the signer thinks it produced a valid sig.

## `feed --in <signed-array.json> --out <feed.json>`

wrap a JSON array of signed alerts into the feed envelope the wallet expects.

```sh
node scripts/publish-alert.mjs feed --in signed-alerts.json --out safety-alerts.json
```

input file (an array of pre-signed alerts):
```json
[
  { /* signed alert 1 */ },
  { /* signed alert 2 */ }
]
```

output:
```json
{
  "v": 1,
  "generatedAtMs": 1712345700000,
  "alerts": [
    { /* signed alert 1 */ },
    { /* signed alert 2 */ }
  ]
}
```

`generatedAtMs` is the publisher's wall clock at feed-build time. wallets use this for "last updated N min ago" UI but don't strictly enforce it (the per-alert `timestampMs` is what time-bounds checks against).

## `sample --priv <b64> --out <sample-feed.json>`

generate a 3-alert demo feed: one critical, one warning, one info, all with 7-day expiry. used for hackathon demos when the production feed isn't reachable.

```sh
node scripts/publish-alert.mjs sample --priv <base64 priv> --out sample-feed.json
```

output: a fully-formed `AlertsFeedResponse` with three alerts ready to drop into the wallet via the dev-injection tRPC procedure (`injectSignedAlertForDev`).

useful workflow:
```sh
# 1. derive the dev key
node scripts/publish-alert.mjs --gen-dev-key
# (copy the priv b64)

# 2. generate a sample feed
node scripts/publish-alert.mjs sample --priv <priv-b64> --out sample.json

# 3. host it locally on a static server, OR

# 4. inject directly via the wallet's dev surface (paste each signed alert
#    from sample.json's "alerts" array into AlertsSettingsSection's
#    dev injection text field)
```

## the canonical-JSON contract

the most subtle invariant: `publish-alert.mjs` and `alerts-types.ts` both implement the same `canonicalAlertBytes` function. they MUST produce identical bytes for the same input.

a single-character mismatch (e.g. extra space, different escape rule) means signatures from the CLI won't validate in the wallet and vice versa. both implementations:

- sort keys alphabetically at every level
- drop fields where value is `undefined` (NOT empty string, NOT null - those stay)
- output `JSON.stringify(...)` without space arg (no whitespace)
- preserve array internal order
- UTF-8 encode the result

if you change one, change the other. there's no automated test that they match across all inputs (would require shared canonical-output property tests). today the convention is "look at both side-by-side when modifying."

## library

- `@noble/ed25519` v3
- `@noble/hashes/sha2` `sha512` (injected into noble/ed25519)
- `@noble/hashes/hmac` `hmac` (also injected)
- node 18+ built-ins (`fs`, `process`, `TextEncoder`)
- internal: `wallet-extension/scripts/publish-alert.mjs`

## related

- [alerts-overview.md](/library/tech/alerts-overview) - the subsystem overview
- [alerts-signed-feed-format.md](/library/tech/alerts-signed-feed-format) - the wire format the CLI produces
- [alerts-publisher-allowlist.md](/library/tech/alerts-publisher-allowlist) - where the pubkey gets pasted
