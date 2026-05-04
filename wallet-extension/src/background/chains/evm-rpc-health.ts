import { STORAGE_KEYS } from '@/background/storage';

const KEY = STORAGE_KEYS.EVM_RPC_HEALTH_V1;

export type RpcHealthEntry = {
  chainId: number;
  rpcUrl: string;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  /** ms for last successful JSON-RPC round-trip (optional, for failover ordering) */
  lastLatencyMs?: number;
};

type Store = Record<string, RpcHealthEntry>;

let cache: Store | null = null;

function mapKey(chainId: number, rpcUrl: string): string {
  return `${chainId}:${rpcUrl}`;
}

async function load(): Promise<Store> {
  if (cache) return cache;
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else {
        cache = (r[KEY] as Store) ?? {};
        resolve(cache);
      }
    });
  });
}

async function save(store: Store): Promise<void> {
  cache = store;
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: store }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function recordRpcSuccess(
  chainId: number,
  rpcUrl: string,
  latencyMs?: number,
): Promise<void> {
  const store = await load();
  const key = mapKey(chainId, rpcUrl);
  const prev = store[key];
  store[key] = {
    chainId,
    rpcUrl,
    lastSuccessAt: Date.now(),
    lastErrorAt: prev?.lastErrorAt,
    lastError: prev?.lastError,
    lastLatencyMs: latencyMs ?? prev?.lastLatencyMs,
  };
  await save(store);
}

/** prefer lower recent latency, unknown latency sorts last, stable tie-break by original order. */
export async function orderRpcUrlsByLatency(chainId: number, urls: string[]): Promise<string[]> {
  const store = await load();
  const order = new Map(urls.map((u, i) => [u, i]));
  return [...urls].sort((a, b) => {
    const la = store[mapKey(chainId, a)]?.lastLatencyMs;
    const lb = store[mapKey(chainId, b)]?.lastLatencyMs;
    const na = la ?? Number.POSITIVE_INFINITY;
    const nb = lb ?? Number.POSITIVE_INFINITY;
    if (na !== nb) return na - nb;
    return (order.get(a) ?? 0) - (order.get(b) ?? 0);
  });
}

export async function recordRpcError(chainId: number, rpcUrl: string, err: unknown): Promise<void> {
  const store = await load();
  const key = mapKey(chainId, rpcUrl);
  const prev = store[key];
  store[key] = {
    chainId,
    rpcUrl,
    lastSuccessAt: prev?.lastSuccessAt,
    lastErrorAt: Date.now(),
    lastError: err instanceof Error ? err.message : String(err),
  };
  await save(store);
}

export async function getRpcHealthForChain(chainId: number): Promise<RpcHealthEntry[]> {
  const store = await load();
  return Object.values(store).filter((x) => x.chainId === chainId);
}
