import { createTRPCProxyClient, httpLink } from '@trpc/client';
import superjson from 'superjson';
import type { AppRouter } from '@/server/router';
import { TRPC_BRIDGE_PORT_NAME } from '@/lib/trpc-bridge-port';

type TrpcBridgeResponse =
  | { ok: true; status: number; body: string; headers: Record<string, string> }
  | { ok: false; error: string };

type TrpcPayload = {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string> | undefined;
};

/** `Headers` is not always structured-clone friendly across the MV3 port; flatten before `postMessage`. */
function flattenHeadersForBridge(h: RequestInit['headers'] | undefined): Record<string, string> | undefined {
  if (h == null) return undefined;
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function responseFromBridge(r: TrpcBridgeResponse): Response {
  if (!r.ok) {
    throw new Error(r.error ?? 'tRPC bridge failed');
  }
  // superjson + empty body => `JSON.parse: unexpected end of input`, surface a clearer cause
  if (r.body == null || r.body === '') {
    throw new Error(
      'tRPC bridge returned an empty response body (MV3 service worker may have restarted mid-request, or the handler crashed before writing a reply). retry after the worker is warm.',
    );
  }
  return new Response(r.body, {
    status: r.status ?? 200,
    headers: r.headers,
  });
}

function isTransientBridgeFailure(msg: string): boolean {
  return (
    /message channel closed before a response/i.test(msg) ||
    /message port closed before a response/i.test(msg) ||
    /extension context invalidated/i.test(msg) ||
    /Receiving end does not exist/i.test(msg)
  );
}

/** cold MV3 SW or flaky port lifecycle - one-shot sendMessage often still works */
function trpcViaSendMessage(payload: TrpcPayload): Promise<TrpcBridgeResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'chromatika-trpc',
        url: payload.url,
        method: payload.method,
        body: payload.body,
        headers: payload.headers,
      },
      (r: TrpcBridgeResponse | undefined) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message ?? 'runtime sendMessage failed'));
          return;
        }
        if (r === undefined) {
          reject(new Error('no response from extension background'));
          return;
        }
        resolve(r);
      },
    );
  });
}

/**
 * URLs whose mutations must NOT be retried by the bridge, they broadcast on-chain,
 * consume one-shot queue entries (dapp/hardware/MCP approval queues), or burn presign
 * ids. re-firing one of these double-spends, hits "no pending request", or wastes a
 * fresh presign. for these, port-disconnect retry, port-to-sendMessage fallback, and the
 * inner port timeout are all disabled. the send/sign UI keeps its primary button
 * disabled while in flight, so a single broadcast attempt is the right contract,
 * surfacing a real failure to the user beats silently double-firing.
 *
 * anything new that broadcasts a tx or pops a one-shot queue MUST be added here.
 */
function isSideEffectMutation(url: string): boolean {
  const noRetryProcedures = [
    // dapp + hardware + mcp approval queues - popping the queue already triggered the work
    '/approveTxRequest',
    '/rejectTxRequest',
    '/approveDappConnection',
    '/rejectDappConnection',
    '/resolveHardwareSign',
    '/rejectHardwareSign',
    '/approvePendingMcpSign',
    '/rejectPendingMcpSign',
    // wallet-ui sends - broadcast on-chain
    '/sendEvmTx',
    '/sendSuiNative',
    '/sendSolanaNative',
    '/sendSplToken',
    '/sendBtcNative',
    // ika MPC sign - burns one presign id per call
    '/signEvm',
    '/signBtc',
    '/signSol',
    '/signAptos',
    // ika dWallet lifecycle - sui/ika txns
    '/registerEncryptionKey',
    '/createDWallet',
    '/acceptEncryptedUserShare',
    '/transferDWallet',
    '/acceptTransferredDWallet',
    '/replenishPresign',
    // sui staking - broadcasts on-chain
    '/ikaStake',
    '/ikaWithdrawStake',
    // swaps + ika fee management - broadcast on-chain
    '/executeSwap',
    '/confirmAndExecuteSwap',
    '/topUpIkaFeePayer',
    '/drainIkaFeePayerToSeeker',
    '/drainAbandonedFeePayer',
  ];
  return noRetryProcedures.some((p) => url.includes(p));
}

function trpcViaPort(payload: TrpcPayload, attempt: number): Promise<TrpcBridgeResponse> {
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: TRPC_BRIDGE_PORT_NAME });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    let settled = false;
    const noRetry = isSideEffectMutation(payload.url);
    // cold MV3: port can connect before the worker answers; no Chrome-side reply timeout, use sendMessage fallback
    const portTimeoutMs = isSideEffectMutation(payload.url)
      ? 0
      : payload.url.includes('/getDwalletHomeGasMany')
        ? 240_000
        : 12_000;

    const cleanup = () => {
      try {
        port.disconnect();
      } catch {
        /* noop */
      }
    };

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const clearPortTimeout = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    const onMessage = (r: TrpcBridgeResponse & { __keepalive?: boolean }) => {
      if (r?.__keepalive) return; // background keepalive ping - ignore
      if (settled) return;
      settled = true;
      clearPortTimeout();
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      cleanup();
      resolve(r);
    };

    const onDisconnect = () => {
      if (settled) return;
      settled = true;
      clearPortTimeout();
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      cleanup();
      const msg =
        chrome.runtime.lastError?.message ??
        'tRPC bridge port disconnected before response (background may have restarted)';
      // never retry side-effect mutations - the background may still be processing
      // and re-sending would either double-fire or hit "no pending approval"
      if (noRetry || attempt >= 2) {
        reject(new Error(msg));
        return;
      }
      setTimeout(() => {
        void trpcViaPort(payload, attempt + 1).then(resolve, reject);
      }, 150);
    };

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    if (portTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearPortTimeout();
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        cleanup();
        reject(new Error('tRPC bridge port response timeout'));
      }, portTimeoutMs);
    }
    try {
      port.postMessage(payload);
    } catch (e) {
      if (settled) return;
      settled = true;
      clearPortTimeout();
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      cleanup();
      if (noRetry || attempt >= 2) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      setTimeout(() => {
        void trpcViaPort(payload, attempt + 1).then(resolve, reject);
      }, 150);
    }
  });
}

function chromeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body =
      init?.body instanceof ArrayBuffer
        ? new TextDecoder().decode(init.body)
        : typeof init?.body === 'string'
          ? init.body
          : undefined;
    const payload: TrpcPayload = {
      url,
      method: init?.method ?? 'GET',
      body,
      headers: flattenHeadersForBridge(init?.headers),
    };

    const timeoutMs =
      url.includes('/approveTxRequest') || url.includes('/executeSwap') || url.includes('/confirmAndExecuteSwap')
        ? 300_000
        : url.includes('/getDwalletHomeGasMany')
          ? 240_000
          : 60_000;
    let done = false;
    const timeoutId = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`request timed out after ${Math.floor(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const finish = () => {
      clearTimeout(timeoutId);
    };

    const runSendMessage = (attempt: number) => {
      trpcViaSendMessage(payload)
        .then((r) => {
          if (done) return;
          finish();
          done = true;
          resolve(responseFromBridge(r));
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          if (attempt < 1 && isTransientBridgeFailure(msg)) {
            setTimeout(() => runSendMessage(attempt + 1), 200);
            return;
          }
          if (done) return;
          finish();
          done = true;
          reject(e instanceof Error ? e : new Error(msg));
        });
    };

    trpcViaPort(payload, 0)
      .then((r) => {
        if (done) return;
        finish();
        done = true;
        resolve(responseFromBridge(r));
      })
      .catch((e) => {
        if (done) return;
        // side-effect mutations must never fall back to sendMessage - retrying
        // would double-fire the approval/swap or hit "no pending approval"
        if (isSideEffectMutation(url)) {
          finish();
          done = true;
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        // port often loses the race with a cold MV3 worker - sendMessage is slower but reliable
        runSendMessage(0);
      });
  });
}

export const trpc = createTRPCProxyClient<AppRouter>({
  links: [
    // httpLink (not batch): batching uses setTimeout + microtask batching; in extension pages that
    // can delay or interact oddly with the mv3 message bridge. single-flight requests are simpler.
    httpLink({
      // fetchRequestHandler expects `endpoint: '/trpc'` and slices the request pathname.
      // if the client url does not include `/trpc`, procedure names get truncated.
      url: 'http://trpc.chromatika/trpc',
      fetch: chromeFetch,
      transformer: superjson,
    }),
  ],
});
