# alerts poller + actions (notifications + dNR rules)

the alerts subsystem polls the feed every 5 minutes via `chrome.alarms`, verifies new alerts, then fires three side-effect categories: in-app banner state update, chrome notifications (critical + warning), and `declarativeNetRequest` redirect rules (critical with affected domains). per-rule TTL alarms clean up dNR rules when alerts expire.

## the poll alarm

```ts
const ALERTS_POLL_PERIOD_MIN = 5;

chrome.alarms.create("chromatika-alerts-poll", { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "chromatika-alerts-poll") {
    void runAlertsPoll();
  }
});
```

set up at install + at SW startup. `ensureAlertsPollAlarm` in `alerts-poller.ts` is idempotent - calling repeatedly doesn't create duplicates.

manual trigger via tRPC `triggerAlertPoll` for the settings page refresh button.

## `runAlertsPoll()`

```ts
async function runAlertsPoll(): Promise<{
  newAlerts: number;
  drops: number;
  error: string | null;
}> {
  const state = await getAlertsState();
  if (state.settings.optedOut) {
    return { newAlerts: 0, drops: 0, error: "opted out" };
  }

  let result;
  try {
    result = await fetchAndVerifyFeed(resolveFeedUrl(state));
  } catch (e) {
    await setLastPollOutcome({ atMs: Date.now(), error: e.message });
    return { newAlerts: 0, drops: 0, error: e.message };
  }

  const { verified, drops } = result;
  const newAlerts = await mergeNewAlerts(verified);

  for (const alert of newAlerts) {
    await runNewAlertActions(alert, state.settings.muted);
  }

  await setLastPollOutcome({ atMs: Date.now(), error: null });
  return { newAlerts: newAlerts.length, drops: drops.length, error: null };
}
```

never throws. exceptions bubble up to the caller as `error: string`. the alarm handler catches and logs but doesn't propagate further (would kill the SW).

## `fetchAndVerifyFeed(feedUrl)`

```ts
async function fetchAndVerifyFeed(feedUrl: string): Promise<FetchResult> {
  // 1. HTTP GET with 25s timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  const resp = await fetch(feedUrl, { signal: controller.signal });
  clearTimeout(timer);

  if (!resp.ok) throw new Error(`feed HTTP ${resp.status}`);

  // 2. parse + Zod validate the feed envelope shape
  const feed = AlertsFeedSchema.parse(await resp.json());
  // { v: 1, generatedAtMs, alerts: unknown[].max(500) }

  // 3. per-alert verify
  const verified: SignedAlertV1[] = [];
  const drops: VerifyDrop[] = [];
  const nowMs = Date.now();

  for (let i = 0; i < feed.alerts.length; i++) {
    const result = await verifySignedAlert(feed.alerts[i], nowMs);
    if (result.ok) verified.push(result.alert);
    else drops.push({ index: i, reason: result.reason, detail: result.detail });
  }

  return { verified, drops, generatedAtMs: feed.generatedAtMs };
}
```

per-alert verification means **one bad alert doesn't poison the batch**. the rest of the feed is still consumed.

## `mergeNewAlerts(verified)`

```ts
async function mergeNewAlerts(verified: SignedAlertV1[]): Promise<SignedAlertV1[]> {
  const state = await getAlertsState();
  const known = new Set(state.knownAlerts.map((a) => a.id));

  const newAlerts = verified.filter((a) => !known.has(a.id));
  if (newAlerts.length === 0) return [];

  const updated = [...state.knownAlerts, ...newAlerts]
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, 200); // FIFO cap

  await chrome.storage.local.set({
    chromatika_alerts_v1: { ...state, knownAlerts: updated },
  });

  return newAlerts;
}
```

dedup by `alert.id`. cap at 200 (oldest pruned). only **new** alerts (first time seen) get returned for action firing - re-seeing an existing alert id is a no-op.

## `runNewAlertActions(alert, muted)`

per-alert side-effects. severity branches the path.

```ts
async function runNewAlertActions(alert: SignedAlertV1, muted: boolean): Promise<void> {
  // 1. always update banner state (banner reads listAlerts; merge already updated)
  // (no explicit call needed - banner re-fetches on its own 30s interval)

  // 2. chrome notifications: critical + warning, unless muted
  if ((alert.severity === "critical" || alert.severity === "warning") && !muted) {
    await fireChromeNotificationForAlert(alert);
  }

  // 3. dNR redirect rules: critical with affected domains only
  if (alert.severity === "critical" && alert.affectedDomains.length > 0) {
    await appendCriticalAlertDnrRules(alert);
  }
}
```

**mute** silences notifications + (implicitly via banner-not-shown) the in-app surface, but does **not** stop dNR rules. mute = "stop yelling," not "ignore threats."

**opt-out** stops the poller entirely. existing dNR rules clear on TTL.

## `fireChromeNotificationForAlert(alert)`

```ts
async function fireChromeNotificationForAlert(alert: SignedAlertV1): Promise<void> {
  const notificationId = `chromatika-alert-${alert.id}`;
  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/alert-icon-128.png"),
    title: `[${alert.severity.toUpperCase()}] ${alert.titleShort}`,
    message: `${alert.bodyLong.slice(0, 200)}${alert.bodyLong.length > 200 ? "…" : ""}`,
    priority: 2,
    requireInteraction: true,
  });
}
```

`requireInteraction: true` means the notification persists until the user dismisses or clicks (vs `false` which auto-dismisses after a few seconds). matches the criticality.

notification id format: `chromatika-alert-<alert.id>`. lets the global click handler in `index.ts` parse the alert id back out:

```ts
chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith("chromatika-alert-")) return;
  const alertId = notificationId.slice("chromatika-alert-".length);
  void openSidePanelForAlert(alertId); // opens side panel with ?alertId=<id>
  chrome.notifications.clear(notificationId);
});
```

side panel reads `?alertId=` from its URL and auto-expands the matching alert in the banner.

## `appendCriticalAlertDnrRules(alert)`

```ts
const ALERT_DNR_RULE_ID_BASE = 10_000;
const ALERT_DNR_RULE_ID_RANGE = 10_000; // 10000-19999

async function appendCriticalAlertDnrRules(alert: SignedAlertV1): Promise<void> {
  const newRules: chrome.declarativeNetRequest.Rule[] = [];
  const newAlarms: { name: string; ruleId: number }[] = [];

  for (const domain of alert.affectedDomains) {
    const stableHash = sha256(`${alert.id}::${domain}`);
    const ruleId = ALERT_DNR_RULE_ID_BASE + (readUint32LE(stableHash) % ALERT_DNR_RULE_ID_RANGE);

    newRules.push({
      id: ruleId,
      priority: 2,
      action: {
        type: "redirect",
        redirect: {
          regexSubstitution:
            chrome.runtime.getURL("phishing-warning.html") +
            `?blocked=${encodeURIComponent(domain)}` +
            `&alertId=${encodeURIComponent(alert.id)}` +
            `&source=chromatika-safety-alert`,
        },
      },
      condition: {
        urlFilter: `||${domain}^`,
        resourceTypes: ["main_frame"],
      },
    });

    const alarmName = `chromatika-alert-rule-${ruleId}`;
    newAlarms.push({ name: alarmName, ruleId });
    chrome.alarms.create(alarmName, { when: alert.expiresAtMs });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: newRules,
    removeRuleIds: [],
  });

  // persist alarm → ruleId mapping for cleanup
  const applied = await chrome.storage.local.get("chromatika_alerts_applied_rules_v1");
  applied.alarmToRuleId = applied.alarmToRuleId ?? {};
  for (const { name, ruleId } of newAlarms) {
    applied.alarmToRuleId[name] = ruleId;
  }
  await chrome.storage.local.set({ chromatika_alerts_applied_rules_v1: applied });
}
```

key invariants:

- **rule id range**: 10000-19999 - non-overlapping with `eth-phishing-detect` (1-4900). 10000 alerts × N domains is a hard ceiling
- **stable hashing**: `sha256(alertId || '::' || domain)` mod range gives the rule id. same alert + same domain always maps to the same id. no need for a global counter
- **priority 2**: higher than eth-phishing-detect's priority 1, so chromatika alerts win on collision
- **redirect target**: `phishing-warning.html?blocked=<domain>&alertId=<id>&source=chromatika-safety-alert`. the warning page reads these params to display context
- **per-rule TTL alarm**: each rule gets its own `chromatika-alert-rule-<ruleId>` alarm scheduled at `alert.expiresAtMs`. when the alarm fires, the rule is removed

## `handleAlertRuleExpiryAlarm(alarmName)`

```ts
async function handleAlertRuleExpiryAlarm(alarmName: string): Promise<void> {
  const applied = await chrome.storage.local.get("chromatika_alerts_applied_rules_v1");
  const ruleId = applied.alarmToRuleId?.[alarmName];
  if (!ruleId) return; // already cleaned up

  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [],
    removeRuleIds: [ruleId],
  });

  delete applied.alarmToRuleId[alarmName];
  await chrome.storage.local.set({ chromatika_alerts_applied_rules_v1: applied });
}
```

removes one rule + cleans up the index. doesn't clean up the corresponding alarm (chrome.alarms self-cleans after firing for non-recurring alarms).

global dispatcher in `index.ts`:

```ts
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith("chromatika-alert-rule-")) {
    void handleAlertRuleExpiryAlarm(alarm.name);
  }
});
```

## the per-rule TTL design rationale

alternative approaches:

- **single sweeper alarm**: one alarm fires periodically, scans all alerts, removes expired ones. simple but coarse - up to N minutes of stale rules
- **per-alert alarm**: one alarm per alert. but an alert can have many domains; multi-domain rule cleanup needs care
- **per-rule alarm** (chosen): one alarm per (alert, domain) pair. precise expiry; clean cleanup logic

con: many alarms if many alerts × many domains. chrome.alarms isn't strictly limited but each alarm is overhead. for typical usage (handful of active alerts, each with 1-3 domains), this is fine.

## opt-out cleanup

opting out doesn't immediately clear all dNR rules - they cleanup on their per-rule TTL alarms, which still fire even if the poller stops. so:

- new poll → skipped (opt-out check)
- existing dNR rules → continue blocking until TTL
- alert history → readable

if you want immediate dNR cleanup on opt-out, that'd be a future enhancement (sweep `applied.alarmToRuleId`, remove all rules at once).

## library

- `chrome.alarms`, `chrome.notifications`, `chrome.declarativeNetRequest`, `chrome.storage`
- `@noble/hashes/sha2` `sha256` for stable rule id hashing
- `zod` for `AlertsFeedSchema` validation
- internal: all in `src/background/alerts/*`

## related

- [alerts-overview.md](/library/tech/alerts-overview) - subsystem overview
- [alerts-signed-feed-format.md](/library/tech/alerts-signed-feed-format) - the verification step inside the poll
- [chrome-alarms-and-idle.md](/library/tech/chrome-alarms-and-idle) - the alarm primitive
- [chrome-declarativenetrequest.md](/library/tech/chrome-declarativenetrequest) - the dNR primitive
- [eth-phishing-detect.md](/library/tech/eth-phishing-detect) - the complementary phishing layer
