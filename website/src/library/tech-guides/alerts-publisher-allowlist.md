# alerts publisher allowlist (`alerts-publishers.ts`)

the bundled list of pubkeys whose alerts the wallet trusts. an alert from any other publisher fails verification with `unknown-publisher`. lives in `wallet-extension/src/background/alerts/alerts-publishers.ts` as a hardcoded TypeScript array. shipped with the extension; updates require a release. future hardening: on-chain Sui Move `PublisherCap` registry for decentralized rotation.

## the shape

```ts
export const BUNDLED_PUBLISHERS_REVISION = 1;

export const PLACEHOLDER_DEV_PUBLISHER_PUBKEY_B64 =
  '+Qzgt7hrnGc94nPyvFFmQuv+EzRxCBvYsCN0XHHkWQA=';

export const BUNDLED_PUBLISHERS: BundledPublisher[] = [
  {
    pubkeyB64: PLACEHOLDER_DEV_PUBLISHER_PUBKEY_B64,
    label: 'chromatika dev publisher (placeholder)',
    addedAt: '2026-04-30',
  },
  // TODO(hackathon): add real chromatika-team production pubkey here
];

interface BundledPublisher {
  pubkeyB64: string;          // base64 32-byte ed25519 pubkey
  label: string;              // human-readable; surfaced in settings UI
  addedAt: string;            // ISO date "YYYY-MM-DD" of when this entry was added
}
```

`isAllowedPublisher(pubkeyB64)` is a simple list-membership check:

```ts
export function isAllowedPublisher(pubkeyB64: string): boolean {
  return BUNDLED_PUBLISHERS.some(p => p.pubkeyB64 === pubkeyB64);
}
```

constant-time comparison would be ideal but here the threat is moot - the pubkey is public-equivalent material; an attacker doesn't gain anything from timing.

## the placeholder dev publisher

the current `PLACEHOLDER_DEV_PUBLISHER_PUBKEY_B64` is the deterministic ed25519 pubkey derived from the seed `chromatika-dev-publisher-v0`:

```js
const SEED = new TextEncoder().encode('chromatika-dev-publisher-v0');
const priv = sha512(SEED).slice(0, 32);
const pub = await ed.getPublicKeyAsync(priv);
// pub b64 = '+Qzgt7hrnGc94nPyvFFmQuv+EzRxCBvYsCN0XHHkWQA='
```

run `node scripts/publish-alert.mjs --gen-dev-key` to regenerate the same keypair anywhere.

since the privkey is deterministic from a known seed, **anyone can sign alerts that the bundled wallet accepts** today. this is intentional for hackathon demos - a developer can locally sign + inject test alerts without setting up real publishing infrastructure.

## the pre-launch TODO

per `wallet-extension/docs/STATUS.md` lines 91-101:

> **Pre-launch TODO**: replace `PLACEHOLDER_DEV_PUBLISHER_PUBKEY_B64` with the real chromatika-team production pubkey. run `node scripts/publish-alert.mjs --gen-key`, save privkey somewhere safe, paste pubkey into `BUNDLED_PUBLISHERS`. bump `BUNDLED_PUBLISHERS_REVISION` so cached alerts re-verify against the new allowlist.

## the revision number

`BUNDLED_PUBLISHERS_REVISION` is an integer that bumps **every time the allowlist changes** (publisher added, removed, or label updated).

```ts
export const BUNDLED_PUBLISHERS_REVISION = 1;
```

stored alerts include the revision they were verified under (in the alerts state's `publishersRevision` field). on read, if the stored revision doesn't match the current bundled revision, **all cached alerts are re-verified**:

```ts
async function getAlertsState(): Promise<AlertsState> {
  const raw = await chrome.storage.local.get('chromatika_alerts_v1');
  let state: AlertsState = raw.chromatika_alerts_v1 ?? defaultState();

  if (state.publishersRevision !== BUNDLED_PUBLISHERS_REVISION) {
    // re-verify all cached alerts
    const reverified: SignedAlertV1[] = [];
    for (const a of state.knownAlerts) {
      const r = await verifySignedAlert(a, Date.now());
      if (r.ok) reverified.push(a);
    }
    state = {
      ...state,
      knownAlerts: reverified,
      publishersRevision: BUNDLED_PUBLISHERS_REVISION,
    };
    await chrome.storage.local.set({ chromatika_alerts_v1: state });
  }

  return state;
}
```

invariant: cached alerts that were verified under an old allowlist (which may have included publishers no longer trusted) get re-verified on the next read. ensures the wallet doesn't keep showing alerts from a publisher we've revoked.

## why hardcoded vs remote allowlist

- **hardcoded**: trust anchor is the extension binary itself. user trusts the chromatika team to ship a correct allowlist via signed CRX updates (chrome's own update verification)
- **remote**: more flexibility (rotate publishers without releases), but introduces a second trust anchor (the allowlist server). compromise of the allowlist server = compromise of the alerting system

production model: hardcoded for now, then move to **on-chain Sui Move `PublisherCap` registry** (per STATUS.md future hardening). `PublisherCap` objects represent the right to publish; transfer = rotate the publisher; on-chain governance = community-rotatable. wallet reads the registry on startup + caches; revocations propagate within minutes.

bundled allowlist becomes the bootstrap layer; on-chain registry becomes the dynamic layer.

## the future cross-publisher case

today the model is "all alerts come from the chromatika team." a single publisher key.

future: multiple publishers (e.g. Solana Foundation, Sui Foundation, third-party security firms). each gets their own pubkey in the allowlist. user can opt-in/opt-out per publisher. tracked future.

## adding a publisher (future workflow)

```sh
# generate a fresh key (offline, secure machine)
node scripts/publish-alert.mjs --gen-key
# (save priv b64 in 1Password, hardware wallet, etc.)
# (copy pub b64)

# edit alerts-publishers.ts
# add entry:
#   { pubkeyB64: '<pub-b64>', label: 'solana foundation security team', addedAt: '2026-05-15' }
# bump BUNDLED_PUBLISHERS_REVISION

# ship a chromatika release with the updated allowlist

# from now on, sign alerts with the new privkey:
node scripts/publish-alert.mjs sign --priv <new-priv> --in unsigned.json --out signed.json
```

## removing a publisher (future workflow)

```sh
# edit alerts-publishers.ts
# remove the entry
# bump BUNDLED_PUBLISHERS_REVISION

# ship a chromatika release

# wallets receive the update; on next getAlertsState read, they
# re-verify cached alerts against the new (smaller) allowlist;
# alerts from the removed publisher are dropped from cache.
# the next poll won't include alerts from the revoked publisher
# (verifySignedAlert returns 'unknown-publisher').
```

## library

- internal: `wallet-extension/src/background/alerts/alerts-publishers.ts`
- internal: `wallet-extension/src/background/alerts/alerts-verify.ts` for `isAllowedPublisher` consumer
- internal: `wallet-extension/src/background/alerts/alerts-store.ts` for the revision-based re-verification

## related

- [alerts-overview.md](/library/tech/alerts-overview) - subsystem overview
- [alerts-signed-feed-format.md](/library/tech/alerts-signed-feed-format) - the verify step that consults this allowlist
- [alerts-publish-cli.md](/library/tech/alerts-publish-cli) - the CLI that generates pubkeys for paste-in here
