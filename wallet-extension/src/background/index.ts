import '@/background/service-worker-document-shim';
import '@/buffer-polyfill';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/router';
import '@/background/lock-manager';
import { isPhishingDomain as _isPhishingDomain } from '@/background/phishing'; void _isPhishingDomain;
import { handleDappRequest } from '@/background/dapp-bridge';
import { DAPP_BRIDGE_PORT_NAME, TRPC_BRIDGE_PORT_NAME } from '@/lib/trpc-bridge-port';
import checkDomain from 'eth-phishing-detect';

export { broadcastToTabs } from '@/background/broadcast';

// --- declarativeNetRequest phishing rules ---
// on install/update, sync the eth-phishing-detect blacklist into dynamic DNR rules
// so Chrome hard-blocks navigation to known phishing domains and redirects to our warning page

const PHISHING_CONFIG_REMOTE =
  'https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/master/src/config.json';

function buildPhishingDnrRules(blacklist: string[]): chrome.declarativeNetRequest.Rule[] {
  const warningBase = chrome.runtime.getURL('phishing-warning.html');
  return blacklist.slice(0, 4900).map((domain, i) => ({
    id: i + 1,
    priority: 100,
    action: {
      type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
      redirect: { url: `${warningBase}?blocked=${encodeURIComponent(domain)}` },
    },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
    },
  }));
}

async function applyPhishingRules(blacklist: string[]): Promise<void> {
  if (!blacklist.length) return;
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = buildPhishingDnrRules(blacklist);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

/** bundled eth-phishing-detect list (works offline). */
async function syncPhishingRules(): Promise<void> {
  try {
    const config = (checkDomain as unknown as { config?: { blacklist?: string[] } }).config;
    await applyPhishingRules(config?.blacklist ?? []);
  } catch (e) {
    console.warn('phishing DNR sync failed:', e);
  }
}

/** fresh blacklist from MetaMask repo (best-effort; falls back to bundled on fetch failure). */
async function refreshPhishingRulesFromRemote(): Promise<void> {
  try {
    const res = await fetch(PHISHING_CONFIG_REMOTE, { cache: 'no-cache' });
    if (!res.ok) {
      console.warn('phishing remote config fetch failed:', res.status);
      return;
    }
    const j = (await res.json()) as { blacklist?: string[] };
    await applyPhishingRules(j.blacklist ?? []);
  } catch (e) {
    console.warn('phishing remote refresh failed:', e);
  }
}

const PHISHING_REFRESH_ALARM = 'chromatika-phishing-refresh';

// --- presign pool auto-replenishment ---
// fires every 5 min; replenishes any pool that drops below the low-water mark
// so signing never blocks on an empty pool during active use

const PRESIGN_ALARM = 'chromatika-presign-refill';
const PRESIGN_LOW_WATER = 3; // replenish when a pool has fewer than this many IDs
const PRESIGN_REFILL_COUNT = 5;

// --- ChromaLab dWallet leaderboard ---
// two cadences:
//   - INDEX walks DWalletCap objects on Sui to discover new dwallet ids (cheap).
//   - PORTFOLIO re-probes the rolling top-N + oldest-stale to keep USD totals fresh.
// both are gated on the user having opted into the leaderboard via prefs; the
// handler reads prefs each fire so toggling is immediate without re-registering.

const LEADERBOARD_INDEX_ALARM = 'chromatika-leaderboard-index';
const LEADERBOARD_PORTFOLIO_ALARM = 'chromatika-leaderboard-portfolio';
const LEADERBOARD_INDEX_INTERVAL_MIN = 30;
const LEADERBOARD_PORTFOLIO_INTERVAL_MIN = 15;

async function isLeaderboardEnabled(): Promise<boolean> {
  try {
    const { STORAGE_KEYS } = await import('@/background/storage/keys');
    const raw = await new Promise<unknown>((resolve) =>
      chrome.storage.local.get([STORAGE_KEYS.LEADERBOARD_PREFS_V1], (r) => resolve(r[STORAGE_KEYS.LEADERBOARD_PREFS_V1])),
    );
    if (raw && typeof raw === 'object' && (raw as { enabled?: unknown }).enabled === true) return true;
  } catch {
    /* default off */
  }
  return false;
}

async function maybeRunLeaderboardIndexTick(): Promise<void> {
  try {
    if (!(await isLeaderboardEnabled())) return;
    const { runIndexOnlyTick } = await import('@/background/services/dwallet-leaderboard-orchestrator');
    await runIndexOnlyTick();
  } catch (e) {
    console.warn('[leaderboard-index] alarm tick failed, will retry next cycle:', e);
  }
}

async function maybeRunLeaderboardPortfolioTick(): Promise<void> {
  try {
    if (!(await isLeaderboardEnabled())) return;
    const { runLeaderboardTick } = await import('@/background/services/dwallet-leaderboard-orchestrator');
    await runLeaderboardTick();
  } catch (e) {
    console.warn('[leaderboard-portfolio] alarm tick failed, will retry next cycle:', e);
  }
}

async function maybeRefillPresignPools(): Promise<void> {
  try {
    const { isUnlocked, getSession } = await import('@/background/session');
    if (!isUnlocked()) return;
    // skip background warming when the active vault is in `seeker_direct` ika fee mode:
    // each presign in that mode requires phone prompts, and waking the user every 5 minutes
    // out of nowhere would be terrible UX. in `seeker_direct`, presigns run lazily on demand,
    // batched into the prompt chain at sign time.
    const s = getSession();
    if (s) {
      const { getIkaFeeSettings } = await import('@/background/ika/fee-settings');
      const settings = await getIkaFeeSettings(s.activeVaultId);
      if (settings.mode === 'seeker_direct') return;
    }
    const { getPresignPoolStatus, replenishPool } = await import('@/background/ika/presign-pool');
    const status = await getPresignPoolStatus();
    const keys = ['SECP256K1_ECDSA', 'SECP256K1_TAPROOT', 'ED25519_EDDSA'] as const;
    for (const key of keys) {
      if (status[key] < PRESIGN_LOW_WATER) {
        await replenishPool(key, PRESIGN_REFILL_COUNT);
      }
    }
  } catch (e) {
    console.warn('[presign-refill] alarm replenish failed, will retry next cycle:', e);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PRESIGN_ALARM) {
    void maybeRefillPresignPools();
  }
  if (alarm.name === PHISHING_REFRESH_ALARM) {
    void refreshPhishingRulesFromRemote();
  }
  if (alarm.name === LEADERBOARD_INDEX_ALARM) {
    void maybeRunLeaderboardIndexTick();
  }
  if (alarm.name === LEADERBOARD_PORTFOLIO_ALARM) {
    void maybeRunLeaderboardPortfolioTick();
  }
  if (alarm.name === 'chromatika-alerts-poll') {
    void (async () => {
      const { runAlertsPoll } = await import('@/background/alerts/alerts-poller');
      await runAlertsPoll();
    })();
  }
  if (alarm.name.startsWith('chromatika-alert-rule-')) {
    void (async () => {
      const { handleAlertRuleExpiryAlarm } = await import('@/background/alerts/alerts-actions');
      await handleAlertRuleExpiryAlarm(alarm.name);
    })();
  }
  if (alarm.name === 'chromatika-media-cache-idle') {
    void (async () => {
      const { maybeCloseIdleOffscreenDoc } = await import('@/background/media-cache-bridge');
      await maybeCloseIdleOffscreenDoc();
    })();
  }
});

// notification click -> open the side panel scoped to the clicked alert id.
if (typeof chrome.notifications?.onClicked?.addListener === 'function') {
  chrome.notifications.onClicked.addListener((notificationId) => {
    if (!notificationId.startsWith('chromatika-alert-')) return;
    const alertId = notificationId.slice('chromatika-alert-'.length);
    void (async () => {
      const { openSidePanelForAlert } = await import('@/background/alerts/alerts-actions');
      await openSidePanelForAlert(alertId);
      try {
        chrome.notifications.clear(notificationId);
      } catch {
        /* best-effort */
      }
    })();
  });
}

/** must match manifest `side_panel.default_path`; explicit setOptions registers the global panel (manifest alone is flaky before another ext page runs) */
const SIDE_PANEL_HTML = 'side_panel.html';

function registerDefaultSidePanel(): void {
  try {
    if (typeof chrome.sidePanel?.setOptions !== 'function') return;
    void chrome.sidePanel.setOptions({ path: SIDE_PANEL_HTML, enabled: true }).catch((e) => {
      console.warn('chromatika: sidePanel.setOptions failed', e);
    });
  } catch (e) {
    console.warn('chromatika: sidePanel.setOptions', e);
  }
}

registerDefaultSidePanel();

/**
 * mcp native-host reconnect: if the user previously enabled the agent surface, re-establish
 * the chrome native messaging port on sw startup. dynamic import keeps cold-start fast for
 * users who haven't enabled mcp.
 */
async function maybeReconnectMcpHost(): Promise<void> {
  try {
    const { getMcpConfig } = await import('@/background/mcp/mcp-storage');
    const cfg = await getMcpConfig();
    if (!cfg.enabled) return;
    const { connectNativeHost } = await import('@/background/mcp/mcp-native-bridge');
    await connectNativeHost();
  } catch (e) {
    console.warn('[mcp] reconnect on startup failed:', e);
  }
}

async function bootstrapAlertsSurface(): Promise<void> {
  try {
    const { ensureAlertsPollAlarm, runAlertsPoll } = await import('@/background/alerts/alerts-poller');
    ensureAlertsPollAlarm();
    void runAlertsPoll();
  } catch (e) {
    console.warn('[chromatika alerts] bootstrap failed:', e);
  }
}

async function bootstrapPcTokenSurface(): Promise<void> {
  try {
    const { bootPcTokenMarkets } = await import('@/background/encrypt-pc/pc-token-markets');
    await bootPcTokenMarkets();
  } catch (e) {
    console.warn('[chromatika pc-token] bootstrap failed:', e);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void syncPhishingRules();
  void refreshPhishingRulesFromRemote();
  registerDefaultSidePanel();
  chrome.alarms.create(PRESIGN_ALARM, { periodInMinutes: 5 });
  chrome.alarms.create(PHISHING_REFRESH_ALARM, { periodInMinutes: 1440 });
  chrome.alarms.create('chromatika-media-cache-idle', { periodInMinutes: 1 });
  chrome.alarms.create(LEADERBOARD_INDEX_ALARM, { periodInMinutes: LEADERBOARD_INDEX_INTERVAL_MIN });
  chrome.alarms.create(LEADERBOARD_PORTFOLIO_ALARM, { periodInMinutes: LEADERBOARD_PORTFOLIO_INTERVAL_MIN });
  void maybeReconnectMcpHost();
  void bootstrapAlertsSurface();
  void bootstrapPcTokenSurface();
});
chrome.runtime.onStartup.addListener(() => {
  void syncPhishingRules();
  void refreshPhishingRulesFromRemote();
  registerDefaultSidePanel();
  // re-create alarm in case service worker was evicted
  chrome.alarms.get(PRESIGN_ALARM, (existing) => {
    if (!existing) chrome.alarms.create(PRESIGN_ALARM, { periodInMinutes: 5 });
  });
  chrome.alarms.get(PHISHING_REFRESH_ALARM, (existing) => {
    if (!existing) chrome.alarms.create(PHISHING_REFRESH_ALARM, { periodInMinutes: 1440 });
  });
  chrome.alarms.get('chromatika-media-cache-idle', (existing) => {
    if (!existing) chrome.alarms.create('chromatika-media-cache-idle', { periodInMinutes: 1 });
  });
  chrome.alarms.get(LEADERBOARD_INDEX_ALARM, (existing) => {
    if (!existing) chrome.alarms.create(LEADERBOARD_INDEX_ALARM, { periodInMinutes: LEADERBOARD_INDEX_INTERVAL_MIN });
  });
  chrome.alarms.get(LEADERBOARD_PORTFOLIO_ALARM, (existing) => {
    if (!existing) chrome.alarms.create(LEADERBOARD_PORTFOLIO_ALARM, { periodInMinutes: LEADERBOARD_PORTFOLIO_INTERVAL_MIN });
  });
  void maybeReconnectMcpHost();
  void bootstrapAlertsSurface();
  void bootstrapPcTokenSurface();
});

type TrpcBridgePayload = {
  url: string;
  method?: string;
  body?: string | null;
  headers?: Record<string, string>;
};

type TrpcBridgeOk = { ok: true; status: number; body: string; headers: Record<string, string> };
type TrpcBridgeErr = { ok: false; error: string };

/**
 * `fetchRequestHandler` slices `pathname` after `/trpc`. if the client URL ever loses that prefix
 * (bad base url, older bundle), the procedure path corrupts and lookups return NOT_FOUND.
 */
function normalizeTrpcBridgeRequestUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname.replace(/\/+/g, '/');
    if (path === '/trpc' || path.startsWith('/trpc/')) return rawUrl;
    const tail = path.replace(/^\//, '');
    if (tail && !tail.includes('/')) {
      u.pathname = `/trpc/${tail}`;
      return u.toString();
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

/** `walletExists` must stay cheap on cold start, never block it behind `unlockVault` (pbkdf2). */
function trpcUrlSkipsSessionWarm(url: string): boolean {
  try {
    const u = new URL(normalizeTrpcBridgeRequestUrl(url));
    return /\/trpc\/walletExists(?:\?|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

async function handleTrpcBridgeFetch(payload: TrpcBridgePayload): Promise<TrpcBridgeOk | TrpcBridgeErr> {
  try {
    const url = normalizeTrpcBridgeRequestUrl(payload.url);
    // auto-recover session if the service worker was evicted and restarted (skip for vault probe only)
    if (!trpcUrlSkipsSessionWarm(url)) {
      const { getSession } = await import('@/background/session');
      if (!getSession()) {
        const { ensureUnlockedSessionFromCache } = await import('@/background/wallet-service');
        await ensureUnlockedSessionFromCache();
      }
    }
    const res = await fetchRequestHandler({
      endpoint: '/trpc',
      req: new Request(url, {
        method: payload.method ?? 'POST',
        headers: payload.headers ? new Headers(payload.headers) : undefined,
        body: payload.body ?? null,
      }),
      router: appRouter,
      createContext: () => ({}),
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { ok: true, status: res.status, body, headers };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** tRPC UI -> background: long-lived port (not sendMessage) so MV3 does not tear down the reply channel mid-flight. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === TRPC_BRIDGE_PORT_NAME) {
    port.onMessage.addListener((raw: unknown) => {
      void (async () => {
        const message = raw as { url?: string; method?: string; body?: string; headers?: Record<string, string> };
        if (!message?.url) {
          try {
            port.postMessage({ ok: false, error: 'Invalid tRPC bridge request' } satisfies TrpcBridgeErr);
          } catch {
            /* port closed */
          }
          return;
        }
        // for long-running mutations (signing, swaps), send periodic keepalive pings
        // so Chrome doesn't treat the port as idle and tear it down
        const isLong =
          message.url.includes('/approveTxRequest') ||
          message.url.includes('/executeSwap') ||
          message.url.includes('/confirmAndExecuteSwap') ||
          message.url.includes('/getDwalletHomeGasMany');
        let keepalive: ReturnType<typeof setInterval> | undefined;
        if (isLong) {
          keepalive = setInterval(() => {
            try { port.postMessage({ __keepalive: true }); } catch { clearInterval(keepalive); }
          }, 20_000);
        }
        const r = await handleTrpcBridgeFetch({
          url: message.url,
          method: message.method,
          body: message.body,
          headers: message.headers,
        });
        if (keepalive) clearInterval(keepalive);
        try {
          port.postMessage(r);
        } catch {
          /* receiver gone */
        }
      })();
    });
    return;
  }

  if (port.name === DAPP_BRIDGE_PORT_NAME) {
    port.onMessage.addListener((raw: unknown) => {
      void (async () => {
        const message = raw as {
          inner?: { id?: string; method?: string; params?: unknown[] };
        };
        const inner = message?.inner;
        if (!inner?.id || !inner?.method) {
          try {
            port.postMessage({ ok: false, error: 'Invalid dapp request' });
          } catch {
            /* port closed */
          }
          return;
        }
        // dapp requests that open approval popups block for a long time:
        // send keepalive pings so Chrome doesn't tear down the port
        const keepalive = setInterval(() => {
          try { port.postMessage({ __keepalive: true }); } catch { clearInterval(keepalive); }
        }, 20_000);
        const r = await handleDappRequest(
          { id: inner.id, method: inner.method, params: inner.params },
          port.sender,
        );
        clearInterval(keepalive);
        try {
          port.postMessage(r);
        } catch {
          /* receiver gone */
        }
      })();
    });
  }
});

/** MV3: if we return true we must call sendResponse exactly once before the channel closes. */
function replyOnce(
  sendResponse: (response?: unknown) => void,
  payload: unknown,
  responded: { current: boolean },
) {
  if (responded.current) return;
  responded.current = true;
  try {
    sendResponse(payload);
  } catch {
    /* channel already closed */
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'chromatika-trpc') {
    const responded = { current: false };
    const m = message as { url?: string; method?: string; body?: string; headers?: Record<string, string> };
    void (async () => {
      try {
        if (!m?.url) {
          replyOnce(sendResponse, { ok: false, error: 'Invalid tRPC bridge request' } satisfies TrpcBridgeErr, responded);
          return;
        }
        const r = await handleTrpcBridgeFetch({
          url: m.url,
          method: m.method,
          body: m.body,
          headers: m.headers,
        });
        replyOnce(sendResponse, r, responded);
      } catch (e) {
        replyOnce(sendResponse, { ok: false, error: e instanceof Error ? e.message : String(e) }, responded);
      }
    })();
    return true;
  }
  if (message?.type === 'chromatika-x402-eligible') {
    // content-script.ts pings this once per page load before deciding whether to install the
    // page-world fetch wrapper. eligible == origin has an active chromatika dapp permission.
    const responded = { current: false };
    void (async () => {
      try {
        const senderWithOrigin = sender as chrome.runtime.MessageSender & { origin?: string };
        const fromOrigin =
          senderWithOrigin.origin ??
          (sender.url ? safeOriginFromUrl(sender.url) : undefined) ??
          (sender.tab?.url ? safeOriginFromUrl(sender.tab.url) : undefined);
        if (!fromOrigin) {
          replyOnce(sendResponse, { eligible: false }, responded);
          return;
        }
        const { getPermission } = await import('@/background/dapp-permissions');
        const rec = await getPermission(fromOrigin);
        replyOnce(sendResponse, { eligible: !!rec?.scope.accounts }, responded);
      } catch {
        replyOnce(sendResponse, { eligible: false }, responded);
      }
    })();
    return true;
  }
  if (message?.type === 'dapp-request') {
    // legacy path: dapp requests now use runtime.connect ports to avoid async sendMessage channel closures
    replyOnce(sendResponse, { ok: false, error: 'dapp-request sendMessage path disabled - use port bridge' }, { current: false });
    return;
  }
  if (message?.type === 'media-cache:ensure-ready') {
    const responded = { current: false };
    void (async () => {
      try {
        const { ensureMediaCacheOffscreenDoc } = await import('@/background/media-cache-bridge');
        await ensureMediaCacheOffscreenDoc();
        replyOnce(sendResponse, { ok: true }, responded);
      } catch (e) {
        replyOnce(sendResponse, { ok: false, error: e instanceof Error ? e.message : String(e) }, responded);
      }
    })();
    return true;
  }
  if (message?.type === 'media-cache:activity-ping') {
    void (async () => {
      const { notifyMediaCacheActivity } = await import('@/background/media-cache-bridge');
      notifyMediaCacheActivity();
    })();
    return false;
  }
});

function safeOriginFromUrl(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
