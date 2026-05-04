import { DAPP_BRIDGE_PORT_NAME } from '@/lib/trpc-bridge-port';

// ask background whether x402 fetch interception should run on this origin. only origins
// that have an active dapp-permissions record (i.e. the user has connected this site via
// the chromatika bridge) get the wrapper. on a `yes`, post the enable event into the page
// world where inject.ts is waiting; on `no` or any error, leave window.fetch alone so we
// don't show up on the fetch call stack of unrelated sites.
try {
  chrome.runtime.sendMessage(
    { type: 'chromatika-x402-eligible' },
    (resp?: { eligible?: boolean }) => {
      if (chrome.runtime.lastError) return; // sw unreachable - default to native fetch
      if (!resp?.eligible) return;
      window.postMessage(
        { source: 'chromatika-content', type: 'chromatika-x402-enable' },
        window.location.origin,
      );
    },
  );
} catch {
  // chrome.runtime gone (extension reloaded mid-page) - native fetch is the safe default
}

// relay background-pushed events (lock/unlock, accountsChanged, chainChanged) to the page
chrome.runtime.onMessage.addListener((message: unknown) => {
  const m = message as { type?: string; event?: string; data?: unknown } | undefined;
  if (m?.type !== 'chromatika-push' || !m.event) return;
  window.postMessage(
    { source: 'chromatika-content', type: 'chromatika-event', event: m.event, data: m.data },
    window.location.origin,
  );
});

window.addEventListener(
  'message',
  (event: MessageEvent) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const d = event.data as {
      source?: string;
      type?: string;
      id?: string;
      method?: string;
      params?: unknown[];
    };
    if (d?.source !== 'chromatika-page' || d?.type !== 'chromatika-dapp-req') return;
    if (!d.id || !d.method) return;

    const postRes = (response: { ok?: boolean; result?: unknown; error?: string; code?: number } | undefined) => {
      window.postMessage(
        {
          source: 'chromatika-content',
          type: 'chromatika-dapp-res',
          id: d.id,
          ok: response?.ok ?? false,
          result: response?.result,
          error: response?.error,
          code: response?.code,
        },
        window.location.origin,
      );
    };

    try {
      const port = chrome.runtime.connect({ name: DAPP_BRIDGE_PORT_NAME });
      const onMessage = (response: {
        ok?: boolean;
        result?: unknown;
        error?: string;
        code?: number;
        __keepalive?: boolean;
      }) => {
        if (response?.__keepalive) return; // background keepalive ping - ignore
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        try { port.disconnect(); } catch { /* noop */ }
        postRes(response);
      };
      const onDisconnect = () => {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        const msg = chrome.runtime.lastError?.message ?? 'dapp bridge disconnected before response';
        postRes({ ok: false, error: msg });
      };
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      port.postMessage({
        inner: { id: d.id, method: d.method, params: d.params },
      });
      return;
    } catch (e) {
      // chrome.runtime.connect throws synchronously when the extension context is gone -
      // most often because the extension was reloaded/updated while this tab stayed open.
      // refreshing the dapp page re-injects a fresh content script bound to the live runtime.
      const raw = e instanceof Error ? e.message : String(e);
      const stale = /extension context invalidated|context invalidated/i.test(raw);
      const hint = stale
        ? 'Chromatika was reloaded - refresh this page to reconnect.'
        : raw;
      postRes({ ok: false, error: `could not open dapp bridge port: ${hint}` });
    }
  },
  false,
);

