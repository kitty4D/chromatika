# `SignedAlertV1` wire format + canonical JSON + ed25519 verify

every safety alert in chromatika is a `SignedAlertV1` JSON envelope: signed-once, immutable, ed25519-verifiable. the wire format and the canonical-JSON serialization rules are shared between the `publish-alert.mjs` CLI (signer) and the wallet (verifier). they **must produce identical bytes** or signatures will never validate.

## the envelope

```ts
interface SignedAlertV1 {
  v: 1;
  id: string;                              // uuid or content-hash; stable identifier
  severity: 'critical' | 'warning' | 'info';
  timestampMs: number;                     // when published (ms since epoch)
  expiresAtMs: number;                     // alert's natural expiry (controls dNR TTL + history pruning)
  affectedDomains: string[];               // lowercased hostnames, no scheme, max 50
  affectedChains?: ('evm' | 'sui' | 'solana' | 'bitcoin' | 'aptos' | 'cross-chain')[];
  titleShort: string;                      // ≤100 chars
  bodyLong: string;                        // ≤4000 chars (markdown ok)
  publisherKeyB64: string;                 // 32-byte ed25519 pubkey, base64
  signatureB64: string;                    // 64-byte ed25519 sig, base64
}
```

example:
```jsonc
{
  "v": 1,
  "id": "uniswap-clone-2026-04-29",
  "severity": "critical",
  "timestampMs": 1712345678000,
  "expiresAtMs": 1712950478000,
  "affectedDomains": ["uniswap-clone-evil.io", "uniswap-v4-airdrop.app"],
  "affectedChains": ["evm"],
  "titleShort": "phishing uniswap clone draining USDC",
  "bodyLong": "Two domains run an exact uniswap v4 UI clone but the swap router transfers USDC to attacker-controlled addresses...",
  "publisherKeyB64": "+Qzgt7hrnGc94nPyvFFmQuv+EzRxCBvYsCN0XHHkWQA=",
  "signatureB64": "<base64 64-byte ed25519 sig>"
}
```

## canonical JSON for signing

ed25519 signatures aren't aware of JSON whitespace or key ordering. to make signatures verifiable across implementations, both sides must serialize the **unsigned envelope** (every field except `signatureB64`) using the same canonical rules:

1. **alphabetical key ordering** at every level
2. **no whitespace** (no spaces, newlines, tabs in the output)
3. **`undefined` values dropped** (treated as if the field weren't there)
4. **UTF-8 encoded output bytes** become the signing input
5. **arrays preserve their internal order** (don't sort array elements)
6. **strings escaped per JSON spec** (control chars, quotes, backslashes)

implementation lives in `src/background/alerts/alerts-types.ts` (`canonicalAlertBytes(unsigned)`) and is mirrored in `scripts/publish-alert.mjs`. they share the same logic verbatim.

```ts
function canonicalAlertBytes(unsigned: UnsignedAlertView): Uint8Array {
  const sorted = sortKeysRecursive(unsigned);
  const json = JSON.stringify(sorted);
  return new TextEncoder().encode(json);
}

function sortKeysRecursive(obj: any): any {
  if (Array.isArray(obj)) return obj.map(sortKeysRecursive);
  if (obj === null || typeof obj !== 'object') return obj;
  const out: Record<string, any> = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] !== undefined) out[key] = sortKeysRecursive(obj[key]);
  }
  return out;
}
```

`unsignedView(alert)` is the helper that strips `signatureB64` from a signed alert before canonicalization.

## the signing primitive

```ts
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';

ed.hashes.sha512 = sha512;       // inject for noble/ed25519 v3
ed.hashes.hmacSha512 = (key, message) => hmac(sha512, key, message);

const canonicalBytes = canonicalAlertBytes(unsignedView(alert));
const sigBytes = await ed.signAsync(canonicalBytes, privKey32);
const signatureB64 = base64Encode(sigBytes);
```

ed25519 RFC 8032 deterministic - same key + same message = same signature. so a publisher signing the same canonical bytes twice produces the same signatureB64.

## the verify pipeline

`verifySignedAlert(raw, nowMs)` in `alerts-verify.ts` runs:

```ts
async function verifySignedAlert(raw: unknown, nowMs: number): Promise<VerifyResult> {
  // 1. shape validation via Zod
  const parsed = SignedAlertV1Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid-shape', detail: parsed.error.message };
  const alert = parsed.data;

  // 2. publisher allowlist check
  if (!isAllowedPublisher(alert.publisherKeyB64)) {
    return { ok: false, reason: 'unknown-publisher', detail: alert.publisherKeyB64 };
  }

  // 3. decode signature + pubkey
  let pubkey: Uint8Array, sig: Uint8Array;
  try {
    pubkey = base64Decode(alert.publisherKeyB64);
    sig = base64Decode(alert.signatureB64);
  } catch (e) {
    return { ok: false, reason: 'invalid-pubkey', detail: e.message };
  }
  if (pubkey.length !== 32) return { ok: false, reason: 'invalid-pubkey', detail: 'not 32 bytes' };
  if (sig.length !== 64) return { ok: false, reason: 'invalid-signature-bytes', detail: 'not 64 bytes' };

  // 4. ed25519 signature verify against canonical bytes
  const canonical = canonicalAlertBytes(unsignedView(alert));
  const valid = await ed.verifyAsync(sig, canonical, pubkey);
  if (!valid) return { ok: false, reason: 'bad-signature' };

  // 5. time bounds: not too old, not from the future
  const ageMs = nowMs - alert.timestampMs;
  if (ageMs > 30 * 24 * 60 * 60 * 1000) return { ok: false, reason: 'time-out-of-range', detail: 'too old (>30d)' };
  if (ageMs < -5 * 60 * 1000) return { ok: false, reason: 'time-out-of-range', detail: 'from the future (>5min skew)' };

  return { ok: true, alert };
}
```

failure modes (all surfaced as `{ ok: false, reason, detail }`):
- `invalid-shape` - Zod schema mismatch (missing field, wrong type, length cap exceeded)
- `unknown-publisher` - pubkey not in `BUNDLED_PUBLISHERS`
- `invalid-pubkey` - base64 decode failed or wrong length
- `invalid-signature-bytes` - base64 decode failed or wrong length
- `bad-signature` - ed25519 verify returned false
- `time-out-of-range` - older than 30 days or more than 5 min in the future

never throws. the poller iterates many alerts; one bad alert shouldn't poison the whole batch.

## why 30-day window for past + 5-min window for future

- **past 30 days**: prevents replaying ancient alerts as if they were fresh. an alert that's been expired for months shouldn't suddenly appear in a user's banner. honest publishers re-publish with a fresh timestamp if they want to keep an alert active beyond 30 days
- **future 5 minutes**: tolerates clock skew (NTP offsets, transit time, publisher being slightly ahead). but blocks an attacker who manages to sign with the right key from setting `timestampMs` far in the future to game the dedup logic

these are heuristic but reasonable defaults. tighter windows would catch edge cases more aggressively at the cost of false rejections.

## Zod schema

```ts
const SignedAlertV1Schema = z.object({
  v: z.literal(1),
  id: z.string().min(1).max(128),
  severity: z.enum(['critical', 'warning', 'info']),
  timestampMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
  affectedDomains: z.array(z.string().min(1).max(255)).max(50),
  affectedChains: z.array(z.enum(['evm', 'sui', 'solana', 'bitcoin', 'aptos', 'cross-chain'])).optional(),
  titleShort: z.string().min(1).max(100),
  bodyLong: z.string().min(0).max(4000),
  publisherKeyB64: z.string().min(1).max(64),
  signatureB64: z.string().min(1).max(128),
});
```

caps protect against pathological input (e.g. an alert with 10000 affectedDomains would inflate dNR rule count).

## library

- `@noble/ed25519` v3 for sign + verify
- `@noble/hashes/sha2` `sha512` (noble/ed25519 v3 needs this injected)
- `@noble/hashes/hmac` `hmac` (also injected for HKDF / hmac-sha512)
- `zod` for shape validation
- internal: `alerts-types.ts` `canonicalAlertBytes`, `unsignedView`
- internal: `alerts-verify.ts` `verifySignedAlert`, `isAllowedPublisher`

## related

- [alerts-overview.md](/library/tech/alerts-overview) - the broader subsystem
- [alerts-publish-cli.md](/library/tech/alerts-publish-cli) - the signer side
- [alerts-publisher-allowlist.md](/library/tech/alerts-publisher-allowlist) - `isAllowedPublisher` source
- [ed25519-eddsa.md](/library/tech/ed25519-eddsa) - underlying signature math
