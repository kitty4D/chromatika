# Safety Alerts (chromatika)

> status: shipped 2026-04-30 (consumer + verifier + DNR-rules + auto-panic SW handler); 2026-05-01 publisher round-trip closed (`--panic-targets` flag + `sample-panic` sub-command + dev-fixture).

## TL;DR

A signed-feed of out-of-band safety alerts from chromatika-team. Each alert carries:
- `severity`: `critical` / `warning` / `info`
- `affectedDomains`: array of phishing / drainer hostnames -> chromatika appends DNR redirect rules to the existing phishing list
- `panicTargets`: array of 0x-prefixed Sui PolicyVault object ids -> chromatika auto-builds a `panic` PTB when the active vault matches

The feed is served as a public read-only HTTP endpoint. Each alert is ed25519-signed by a chromatika-team key (or the deterministic dev-publisher key during local development). Verification + canonical-JSON serializer live at `src/background/alerts/alerts-types.ts` (`canonicalJsonStringify`); the publisher CLI at `scripts/publish-alert.mjs` mirrors the same serializer so signatures verify.

## Architecture

```
scripts/publish-alert.mjs          ed25519 sign CLI (gen-key, sign, feed, sample, sample-panic)
public/dev-fixtures/               local dev feed for testing the SW poll path
src/background/alerts/
├── alerts-types.ts                SignedAlertV1 / UnsignedAlertV1 / AlertsFeedResponse +
│                                  canonicalJsonStringify (must match publisher byte-for-byte)
├── alerts-publishers.ts           BUNDLED_PUBLISHERS allowlist + dev-publisher placeholder
├── alerts-verify.ts               ed25519 sig check + structural validation
├── alerts-fetch.ts                ~5min poll loop, dedupes via `id`
├── alerts-store.ts                merges new alerts into chrome.storage.local
└── alerts-actions.ts              DNR redirect rules + chrome notification +
                                   auto-panic SW handler (autoPanicPolicyTargetsForAlert)
```

## Publisher CLI

### Generate a key

Production:
```
node scripts/publish-alert.mjs --gen-key
```
Outputs a fresh keypair. Save the privkey somewhere safe (1password / hardware wallet); paste the pubkey into `BUNDLED_PUBLISHERS` in `src/background/alerts/alerts-publishers.ts`.

Dev:
```
node scripts/publish-alert.mjs --gen-dev-key
```
Outputs the deterministic dev publisher keypair. Anyone can rederive this; use only for local development. Pubkey: `+Qzgt7hrnGc94nPyvFFmQuv+EzRxCBvYsCN0XHHkWQA=`.

### Sign an alert

Hand-author an unsigned envelope:

```
{
  "v": 1,
  "id": "incident-2026-05-01",
  "severity": "critical",
  "timestampMs": 1777693585502,
  "expiresAtMs": 1778298385502,
  "affectedDomains": ["drainer.example"],
  "affectedChains": ["evm"],
  "titleShort": "Active drainer reported",
  "bodyLong": "Long-form description.",
  "publisherKeyB64": "<your-pubkey-b64>"
}
```

Sign:

```
node scripts/publish-alert.mjs sign --priv <b64> --in unsigned.json --out signed.json
```

Sign with `panicTargets` populated (auto-panic):

```
node scripts/publish-alert.mjs sign --priv <b64> --in unsigned.json --out signed.json \
  --panic-targets 0xabcd...,0xefgh...
```

### Wrap into a feed

```
node scripts/publish-alert.mjs feed --in signed-array.json --out feed.json
```

`signed-array.json` is a JSON array of one or more signed alerts; `feed.json` is the `AlertsFeedResponse` envelope chromatika expects.

### One-shot sample fixtures

3-alert mixed-severity sample (no panicTargets):

```
node scripts/publish-alert.mjs sample --priv <dev-priv> --out public/dev-fixtures/sample-alerts-feed.json
```

1-alert auto-panic sample with a placeholder vault id:

```
node scripts/publish-alert.mjs sample-panic --priv <dev-priv> \
  --out public/dev-fixtures/sample-panic-alert-feed.json \
  --panic-targets 0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
```

## End-to-end runbook (auto-panic, two profiles)

This runbook validates that a chromatika-team-signed alert with `panicTargets` reliably flips the on-chain panic flag for an opted-in PolicyVault.

### Setup (once)

1. Build + deploy the `chromatika_policy::sign_gate` Move package to Sui testnet (see `docs/POLICY_VAULT.md` deploy runbook). Capture the package id.
2. Optional: stand up a tiny static-file host serving the `public/dev-fixtures/` directory (or use chromatika's own dev server). Note the URL where `sample-panic-alert-feed.json` will live.

### Profile A (the user being protected)

1. Open chromatika -> Settings -> Security -> "On-chain spend caps + panic button".
2. Paste the deployed package id; save.
3. Click "opt in: wrap dWallet cap into PolicyVault". Use small test values for the demo:
   - daily cap: $5
   - cool-down: 60s
   - unfreeze delay: 60s (test mode; default is 7 days)
   - stage-cap-raises delay: 1 hour (default 24h; staging stays OFF until you toggle)
   - rescue address: optional
   - initial IKA / SUI: 0.01 each
4. After opt-in, copy the vault object id from the panel.
5. Add chromatika-team's Sui address (or any second test address) as an actuator.

### Repoint the alert feed (dev test)

Edit `src/background/alerts/alerts-fetch.ts` to point at your local feed URL, or use the existing override hook (look for `INJECT_VERIFIED_ALERT_FOR_DEV` test seam). Reload the extension.

### Generate the panic alert

```
node scripts/publish-alert.mjs sample-panic \
  --priv <dev-priv> \
  --out public/dev-fixtures/sample-panic-alert-feed.json \
  --panic-targets <profile-A-vault-id>
```

### Trigger the round-trip

1. Open chromatika side panel; the next poll cycle (~5 min by default; force-refresh via the dev seam) picks up the alert.
2. SW: `runNewAlertActions` runs:
   - `appendCriticalAlertDnrRules` adds DNR redirect rules for `affectedDomains` (empty in this fixture).
   - `fireChromeNotificationForAlert` shows the OS notification (subject to `muted`).
   - `autoPanicPolicyTargetsForAlert` resolves `panicTargets`, looks up the local link, and signs a `panic` PTB.
3. On-chain: the vault's `panicked = true`; the operation-progress banner reflects "auto-panic from safety alert".
4. Verify in the panel: status banner flips to "PANICKED: all signing frozen"; unfreeze countdown shows the 60s delay.
5. After the unfreeze delay, click UNFREEZE -> banner clears; signing resumes.

### Cleanup

If running against a shared dev feed: rotate the `id` and `--panic-targets` so other profiles don't auto-panic. The publisher CLI uses a timestamp-based id by default so re-running `sample-panic` produces a new entry; the consumer dedupes on the `id` field.

## Threat model fit

- chromatika-team auto-panic is **opt-in by adding the team's address as one of your actuators** at PolicyVault opt-in. No actuator -> no auto-panic capability. The mechanism is fail-safe (less actuators = less attack surface).
- A compromised chromatika-team key forges any alert content but cannot sign panic txs without being a registered actuator. Defense-in-depth: rotate the publisher pubkey via a new release, refuse alerts older than the rotation timestamp.
- A compromised user device can locally suppress the alert before the SW handler runs. The vault remains exposed in that scenario (which is why the user wires multiple actuators including a friend or chromatika-team independently).

## Related docs

- [`POLICY_VAULT.md`](POLICY_VAULT.md): the on-chain primitive auto-panic targets
- [`STATUS.md`](STATUS.md): single-source shipped/gated/future index
