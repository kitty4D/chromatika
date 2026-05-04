/** max age of `latest` block timestamp before we warn the RPC may be out of sync (2 minutes). */
const STALE_BLOCK_MS = 120_000;

function parseRpcChainId(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw);
  if (/^0x[0-9a-fA-F]+$/i.test(s)) return Number.parseInt(s, 16);
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : Number.NaN;
}

async function ethJsonRpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = (await res.json()) as { result?: T; error?: { message?: string; code?: number } };
  if (j.error) throw new Error(j.error.message ?? `RPC error ${j.error.code ?? ''}`);
  return j.result as T;
}

/**
 * call eth_chainId and optional latest block timestamp before trusting a custom EVM RPC.
 */
export async function verifyEvmRpcForChain(
  declaredChainId: number,
  rpcUrl: string,
): Promise<{ ok: true; warnings: string[] } | { ok: false; error: string }> {
  const warnings: string[] = [];
  try {
    const chainIdRaw = await ethJsonRpc<unknown>(rpcUrl, 'eth_chainId', []);
    const reported = parseRpcChainId(chainIdRaw);
    if (!Number.isFinite(reported) || reported !== declaredChainId) {
      return {
        ok: false,
        error: `RPC reports chainId ${reported} but expected ${declaredChainId}. use a different RPC or fix the chain id.`,
      };
    }

    try {
      const block = await ethJsonRpc<{ timestamp?: string } | null>(rpcUrl, 'eth_getBlockByNumber', [
        'latest',
        false,
      ]);
      if (block?.timestamp) {
        const blockMs = Number.parseInt(block.timestamp, 16) * 1000;
        if (Number.isFinite(blockMs) && Date.now() - blockMs > STALE_BLOCK_MS) {
          warnings.push(
            `latest block is ~${Math.round((Date.now() - blockMs) / 1000)}s old — RPC may be lagging or wrong network.`,
          );
        }
      }
    } catch {
      /* optional check */
    }

    return { ok: true, warnings };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
