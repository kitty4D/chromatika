# safety alerts subsystem overview

chromatika polls a signed JSON feed for in-the-wild attack reports (phishing, drainers, scam dapps), verifies each alert's ed25519 signature against a bundled publisher allowlist, and surfaces verified alerts via three layers: in-app banner, chrome notifications (critical), and chrome's `declarativeNetRequest` URL-blocking layer (critical with affected domains). complementary to the existing `eth-phishing-detect` MetaMask blocklist; non-overlapping rule ID range so the two coexist.

shipped per `wallet-extension/docs/STATUS.md` lines 91-101 with one remaining pre-mainnet step: replace the placeholder dev publisher pubkey with the production key (see [alerts-publisher-allowlist.md](/library/tech/alerts-publisher-allowlist)).

## the three severity levels

| severity   | banner | chrome notification | dNR redirect rule          |
| ---------- | ------ | ------------------- | -------------------------- |
| `critical` | ✓      | ✓ (unless muted)    | ✓ for each affected domain |
| `warning`  | ✓      | ✓ (unless muted)    | ✗                          |
| `info`     | ✓      | ✗                   | ✗                          |

example uses:

- **critical**: phishing Uniswap clone with approval-draining contracts; token-account drain vector on Solana
- **warning**: sketchy NFT mint sites; suspicious DeFi protocols
- **info**: educational reminders ("revoke unused approvals periodically")

## the file layout

| file                                          | role                                                           |
| --------------------------------------------- | -------------------------------------------------------------- |
| `src/background/alerts/alerts-types.ts`       | `SignedAlertV1` type + canonical JSON serializer               |
| `src/background/alerts/alerts-store.ts`       | persistence to `chromatika_alerts_v1`, dedup, dismiss          |
| `src/background/alerts/alerts-fetch.ts`       | HTTP fetch + per-alert verification pipeline                   |
| `src/background/alerts/alerts-verify.ts`      | ed25519 signature verify + time-bounds + publisher allowlist   |
| `src/background/alerts/alerts-actions.ts`     | chrome.notifications + dNR rule append + per-rule TTL alarms   |
| `src/background/alerts/alerts-poller.ts`      | 5-min alarm + manual trigger                                   |
| `src/background/alerts/alerts-publishers.ts`  | bundled allowlist (`BUNDLED_PUBLISHERS`) + revision number     |
| `src/server/routers/alerts.ts`                | tRPC procedures (list / dismiss / settings / trigger / inject) |
| `src/ui/components/AlertBanner.tsx`           | persistent banner in `MainWalletShell`                         |
| `src/ui/components/AlertsSettingsSection.tsx` | settings UI (mute / opt-out / custom feed / history)           |
| `scripts/publish-alert.mjs`                   | CLI for generating keys, signing alerts, building feeds        |

mount points:

- `src/server/router.ts` line 38: `...alertsProcedures` joins the tRPC root
- `src/background/index.ts` lines 113-185: alarm dispatchers + bootstrap

## the storage shape (`chromatika_alerts_v1`)

```ts
interface AlertsState {
  v: 1;
  knownAlerts: SignedAlertV1[]; // verified alerts ever seen, capped 200, FIFO by timestamp
  dismissedIds: string[]; // user-dismissed alert ids
  settings: {
    muted: boolean; // suppress notifications + banner (NOT dNR rules)
    customFeedUrl: string; // empty = default
    optedOut: boolean; // poller stops; dNR rules clear on TTL
  };
  lastPolledAtMs: number;
  lastPollError: string | null;
  publishersRevision: number; // bumped on allowlist rotation; triggers re-verify
}
```

note: a separate `chromatika_alerts_applied_rules_v1` storage tracks `{ alarmToRuleId: { alarmName → ruleId } }` for granular per-rule TTL cleanup.

## the data flow

```
1. publisher signs an alert offline:
   publish-alert.mjs sign --priv <b64> --in unsigned.json --out signed.json
   - canonicalizes JSON (key-sorted, undefined dropped)
   - ed25519_sign(canonical_bytes, priv_key) → signatureB64

2. publisher composes a feed:
   publish-alert.mjs feed --in signed-array.json --out feed.json
   - wraps as { v: 1, generatedAtMs, alerts: [...] }

3. publisher hosts feed at https://www.chromatika.xyz/safety-alerts.json (or wherever)

4. chromatika polls every 5 min:
   chrome.alarms 'chromatika-alerts-poll'
   → fetchAndVerifyFeed(feedUrl)
     → HTTP GET (anonymous, 25s timeout)
     → parse JSON, validate shape with Zod
     → per-alert: verifySignedAlert (signature + allowlist + time-bounds)
     → drops bad alerts, keeps the good ones
   → mergeNewAlerts(verified)  // dedup by id, cap at 200
   → for each new alert: runNewAlertActions(alert, muted)
     → critical: append dNR redirect rules + chrome notification (unless muted)
     → warning: chrome notification (unless muted)
     → info: banner-only (no notification, no dNR)
   → setLastPollOutcome({ atMs, error })

5. UI surfaces:
   - AlertBanner (refetches listAlerts every 30s, shows highest-severity active)
   - AlertsSettingsSection (mute / opt-out / custom URL / history / dev injection)
   - chrome notifications (clicking opens side panel with ?alertId=<id>)
   - dNR rule (typing flagged URL redirects to phishing-warning.html?blocked=<domain>&alertId=<id>)
```

## privacy properties

- feed fetch is anonymous HTTP GET. no cookies, no auth headers, no wallet-specific params
- the feed is **static JSON** - same URL for all users, same content regardless of who's polling. no per-user response variation possible
- ISP / DNS resolvers can see "this user polls www.chromatika.xyz every 5 min" but not what's in the wallet
- dNR rules are local; no phone-home on navigation to flagged domains

## composition with eth-phishing-detect

|                | eth-phishing-detect                          | chromatika alerts                   |
| -------------- | -------------------------------------------- | ----------------------------------- |
| source         | bundled list + daily MetaMask config refresh | signed feed, 5-min poll             |
| signing        | none (trust upstream maintainer)             | ed25519 per alert                   |
| dNR rule IDs   | 1-4900                                       | 10000-19999                         |
| severity       | one tier (block)                             | three tiers (critical/warning/info) |
| in-app surface | none                                         | banner + settings + notifications   |
| TTL            | full sync each refresh                       | per-alert `expiresAtMs`             |

both layers operate in parallel without collision. eth-phishing-detect catches the long-tail of known-bad domains; chromatika alerts catch zero-day campaigns or chromatika-specific threats.

## pre-mainnet steps (gated on chromatika launch)

per STATUS.md:

- replace `PLACEHOLDER_DEV_PUBLISHER_PUBKEY_B64` in `alerts-publishers.ts` with the production chromatika-team pubkey
- run `node scripts/publish-alert.mjs --gen-key`, save the privkey somewhere safe (hardware wallet, 1Password), paste pubkey into `alerts-publishers.ts`
- bump `BUNDLED_PUBLISHERS_REVISION` so cached alerts re-verify against the new allowlist

future hardening:

- on-chain Sui Move `BroadcastChannel` object + `PublisherCap` registry (decentralize allowlist)
- Walrus body storage for long-form alerts
- soft-block dapp-bridge `window.ethereum` connect on flagged sites (complementary to dNR)

## related deep dives

- [alerts-signed-feed-format.md](/library/tech/alerts-signed-feed-format) - SignedAlertV1 shape + canonical JSON + ed25519 verify pipeline
- [alerts-publish-cli.md](/library/tech/alerts-publish-cli) - publish-alert.mjs CLI usage
- [alerts-poller-and-actions.md](/library/tech/alerts-poller-and-actions) - polling schedule + notifications + dNR rule lifecycle
- [alerts-publisher-allowlist.md](/library/tech/alerts-publisher-allowlist) - bundled allowlist + revision bumps
- [mcp-list-active-alerts-tool.md](/library/tech/mcp-list-active-alerts-tool) - the new MCP read-tier tool that exposes alerts to AI agents
- [safety-alerts.md](/library/user/safety-alerts) (user-guides) - the user-facing flow
