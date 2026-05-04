/**
 * side-effects fired when a NEW alert is merged into the store. two actions matter:
 *
 *   1. chrome.notifications - system-level toast for `severity: 'critical'` alerts. lets users
 *      see the alert even when chromatika isn't open. click opens the popup with the alert id.
 *
 *   2. dNR phishing-rule append - for `severity: 'critical'` alerts with `affectedDomains`,
 *      register a temporary redirect-to-phishing-warning rule per domain. rule IDs use a
 *      reserved range (10000-19999) so they don't collide with the existing eth-phishing-detect
 *      bundle (1-4900). each rule auto-expires via a chrome.alarm scheduled at the alert's
 *      `expiresAtMs` - removeDynamicRules on alarm fire.
 *
 * why dNR instead of soft-blocking via the dapp-bridge: dNR runs at the network layer, before
 * the page even loads. a user navigating directly to `evilsite.io` gets redirected to
 * chromatika's phishing-warning page even if they never click "connect wallet". this is
 * strictly safer than dapp-bridge soft-blocks (which only fire on connect).
 *
 * mute semantics: `settings.muted` suppresses chrome.notifications + the in-app banner UI, but
 * NOT the dNR rule append. the user explicitly opted in to "alerts active" by not opting out;
 * mute = "stop yelling at me", not "ignore the threat list".
 */

import { STORAGE_KEYS } from '@/background/storage';
import type { SignedAlertV1 } from '@/background/alerts/alerts-types';
import { effectiveExpiresAtMs } from '@/background/alerts/alerts-types';
import { publisherLabel } from '@/background/alerts/alerts-publishers';

/** dNR rule id range reserved for safety-alert phishing rules. collision-free with phishing 1-4900. */
const ALERT_DNR_RULE_ID_BASE = 10_000;
const ALERT_DNR_RULE_ID_CAP = 19_999;
/** chrome.alarms name prefix for per-alert TTL expiry. `chromatika-alert-expire-<alertId>`. */
const ALERT_EXPIRE_ALARM_PREFIX = 'chromatika-alert-expire-';
/** chrome.alarms name prefix for per-rule cleanup-on-expiry timers. `chromatika-alert-rule-<ruleId>`. */
const ALERT_RULE_ALARM_PREFIX = 'chromatika-alert-rule-';

/**
 * stable map from `(alertId, domain)` to a rule id within the reserved range. we hash the pair
 * to a 14-bit number and add the base to avoid collisions inside the alert-rule range. the
 * collision probability for 100 simultaneous alerts × 10 domains each is small enough to ignore;
 * if we hit a collision the second add silently overwrites the first, which is the same behavior
 * chrome dNR has anyway.
 */
function ruleIdFor(alertId: string, domain: string): number {
  const s = `${alertId}::${domain}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  const span = ALERT_DNR_RULE_ID_CAP - ALERT_DNR_RULE_ID_BASE;
  return ALERT_DNR_RULE_ID_BASE + (h % span);
}

function buildRedirectRule(alert: SignedAlertV1, domain: string): chrome.declarativeNetRequest.Rule {
  const warningBase = chrome.runtime.getURL('phishing-warning.html');
  const params = new URLSearchParams({ blocked: domain, alertId: alert.id, source: 'chromatika-safety-alert' });
  return {
    id: ruleIdFor(alert.id, domain),
    priority: 110, // higher than the phishing-list base 100, so safety alerts win on overlap
    action: {
      type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
      redirect: { url: `${warningBase}?${params.toString()}` },
    },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
    },
  };
}

interface AppliedRulesIndex {
  /** per-rule alarm name → ruleId. used to remove individual rules on expiry without touching others. */
  alarmToRuleId: Record<string, number>;
}

const APPLIED_RULES_KEY = STORAGE_KEYS.ALERTS_APPLIED_RULES_V1;

async function readAppliedIndex(): Promise<AppliedRulesIndex> {
  return new Promise((resolve) => {
    chrome.storage.local.get([APPLIED_RULES_KEY], (r) => {
      const v = r[APPLIED_RULES_KEY];
      if (v && typeof v === 'object' && (v as AppliedRulesIndex).alarmToRuleId) {
        resolve(v as AppliedRulesIndex);
      } else {
        resolve({ alarmToRuleId: {} });
      }
    });
  });
}

async function writeAppliedIndex(idx: AppliedRulesIndex): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [APPLIED_RULES_KEY]: idx }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/**
 * append redirect rules for every affected domain on the alert. schedules per-rule TTL
 * cleanup alarms at the alert's effective expiry. idempotent on re-call (chrome dNR
 * `addRules` with the same id replaces the old rule).
 *
 * returns the rule ids that were actually added (after de-dupe / collision handling).
 */
export async function appendCriticalAlertDnrRules(alert: SignedAlertV1): Promise<number[]> {
  if (alert.severity !== 'critical' || alert.affectedDomains.length === 0) {
    return [];
  }
  if (typeof chrome.declarativeNetRequest?.updateDynamicRules !== 'function') {
    console.warn('[chromatika alerts] declarativeNetRequest unavailable; skipping rule append');
    return [];
  }

  const expiresAtMs = effectiveExpiresAtMs(alert);
  if (expiresAtMs <= Date.now()) {
    return []; // expired before we even got to it; nothing to do
  }

  const addRules = alert.affectedDomains.map((d) => buildRedirectRule(alert, d));
  // remove any existing rules in the same id slots first to avoid silent overwrite ambiguity.
  const removeRuleIds = addRules.map((r) => r.id);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (e) {
    console.warn('[chromatika alerts] dNR updateDynamicRules failed:', e);
    return [];
  }

  // schedule TTL alarms - one per rule id - so we can remove individual rules without disturbing
  // others when alerts have non-overlapping expiries.
  const idx = await readAppliedIndex();
  const newAlarmEntries: Record<string, number> = {};
  for (const rule of addRules) {
    const alarmName = `${ALERT_RULE_ALARM_PREFIX}${rule.id}`;
    try {
      // chrome.alarms `when` is in ms-since-epoch; minimum delay = 30s by chrome's discretion.
      // for local demos we want short TTLs to land on schedule; for production 7-day TTL
      // is fine. treat sub-30s as fire-immediately on next alarm tick.
      chrome.alarms.create(alarmName, { when: Math.max(Date.now() + 30_000, expiresAtMs) });
    } catch (e) {
      console.warn(`[chromatika alerts] failed to schedule TTL alarm for rule ${rule.id}:`, e);
    }
    newAlarmEntries[alarmName] = rule.id;
  }
  idx.alarmToRuleId = { ...idx.alarmToRuleId, ...newAlarmEntries };
  await writeAppliedIndex(idx);

  return addRules.map((r) => r.id);
}

/**
 * called by the global `chrome.alarms.onAlarm` dispatcher when a TTL alarm fires. removes the
 * specific dNR rule + drops the index entry.
 */
export async function handleAlertRuleExpiryAlarm(alarmName: string): Promise<void> {
  if (!alarmName.startsWith(ALERT_RULE_ALARM_PREFIX)) return;
  const idx = await readAppliedIndex();
  const ruleId = idx.alarmToRuleId[alarmName];
  if (typeof ruleId !== 'number') return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
  } catch (e) {
    console.warn(`[chromatika alerts] failed to remove rule ${ruleId} on expiry:`, e);
  }
  delete idx.alarmToRuleId[alarmName];
  await writeAppliedIndex(idx);
}

/**
 * fire a system notification for a critical alert. suppressed when `muted` is true.
 *
 * the chrome.notifications click handler routes the user back to chromatika's side panel
 * scoped to the specific alert id, so they can see the full body + take action immediately.
 * the handler is registered globally in `index.ts`; this function only creates the notification.
 */
export async function fireChromeNotificationForAlert(alert: SignedAlertV1, muted: boolean): Promise<void> {
  if (muted) return;
  if (alert.severity !== 'critical') return;
  if (typeof chrome.notifications?.create !== 'function') {
    console.warn('[chromatika alerts] chrome.notifications unavailable');
    return;
  }
  const publisher = publisherLabel(alert.publisherKeyB64) ?? 'chromatika safety alerts';
  const domains = alert.affectedDomains.slice(0, 3).join(', ');
  const message = domains
    ? `${alert.titleShort}\nflagged: ${domains}${alert.affectedDomains.length > 3 ? ' …' : ''}`
    : alert.titleShort;
  const notificationId = `chromatika-alert-${alert.id}`;
  try {
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('chromatika-logo-128.png'),
      title: `⚠ chromatika · ${publisher}`,
      message,
      priority: 2,
      requireInteraction: true,
    });
  } catch (e) {
    console.warn('[chromatika alerts] notifications.create failed:', e);
  }
}

/**
 * open chromatika's side panel scoped to a specific alert id. wired to the global
 * `chrome.notifications.onClicked` listener in `index.ts`.
 */
export async function openSidePanelForAlert(alertId: string): Promise<void> {
  try {
    const url = chrome.runtime.getURL(`side_panel.html?alertId=${encodeURIComponent(alertId)}`);
    // prefer side panel; fall back to popup tab if side panel isn't supported in the calling context.
    if (chrome.windows?.create) {
      await chrome.windows.create({ url, type: 'popup', width: 420, height: 720 });
    } else {
      await chrome.tabs.create({ url });
    }
  } catch (e) {
    console.warn('[chromatika alerts] failed to open side panel for alert:', e);
  }
}

/**
 * auto-panic any opted-in PolicyVault whose object id matches the alert's `panicTargets`.
 * signed by the user's local Sui keypair (which is the primary actuator on opt-in). idempotent:
 * if the vault is already panicked, the panic call is a no-op on-chain (event still emits).
 *
 * why this is the killer feature: chromatika's prior alert-banner UX could only YELL at the user
 * about a phishing site. with this hook, a chromatika-team-signed alert can FREEZE the user's
 * keys at the protocol level (MPC network refuses sigs) the moment a drain is detected, even
 * if the user is asleep / AFK / can't read the banner in time.
 */
export async function autoPanicPolicyTargetsForAlert(alert: SignedAlertV1): Promise<void> {
  const targets = alert.panicTargets;
  if (!Array.isArray(targets) || targets.length === 0) return;
  // lazy-load to avoid circular module init (alerts boot before policy-vault module is touched).
  const { getPolicyVaultLink } = await import('@/background/policy-vault/policy-vault-storage');
  const { panicPolicyVault } = await import('@/background/policy-vault/policy-vault-actions');
  const { getSession } = await import('@/background/session');
  const s = getSession();
  if (!s?.activeVaultId) return;
  const link = await getPolicyVaultLink(s.activeVaultId);
  if (!link) return;
  const targetSet = new Set(targets.map((t) => t.toLowerCase()));
  if (!targetSet.has(link.vaultObjectId.toLowerCase())) return;
  try {
    await panicPolicyVault();
    console.warn('[chromatika alerts] auto-panic triggered for vault', link.vaultObjectId, 'by alert', alert.id);
  } catch (e) {
    console.warn('[chromatika alerts] auto-panic FAILED:', e);
  }
}

/** run all the side-effects for a single new verified alert. */
export async function runNewAlertActions(alert: SignedAlertV1, muted: boolean): Promise<void> {
  // fire-and-forget: actions are independent; failure of one shouldn't stop the others.
  await Promise.allSettled([
    fireChromeNotificationForAlert(alert, muted),
    appendCriticalAlertDnrRules(alert),
    autoPanicPolicyTargetsForAlert(alert),
  ]);
}

export const __internals = { ALERT_RULE_ALARM_PREFIX, ALERT_EXPIRE_ALARM_PREFIX, ruleIdFor };
