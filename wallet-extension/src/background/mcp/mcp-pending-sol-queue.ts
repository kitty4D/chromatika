/**
 * in-memory queue for MCP-initiated Solana send requests that need user approval. parallel
 * structure to `mcp-pending-queue.ts` (which handles `signMessage`). the popup-mediated tRPC
 * procedures resolve via `resolvePendingMcpSendSol` on approve, `rejectPendingMcpSendSol` on
 * cancel.
 *
 * v1 scope: native SOL transfer + SPL token transfer. discriminated by presence of `mint`:
 * native if `mint` absent (uses `lamports`); SPL if `mint` present (uses `amountRaw` in
 * base-units). future slices: raw VersionedTransaction signing, multi-ix programs.
 */

import { getPopupPosition } from '@/background/popup-position';

const POPUP_WIDTH = 420;
const POPUP_HEIGHT = 560;
const MAX_LAMPORTS = 1_000_000_000_000n; // 1000 SOL: sanity cap, easily lifted later

/**
 * pending MCP-initiated Solana transfer request. discriminated on `kind`:
 *   - `'native'`: pass `lamports`. SPL fields are absent.
 *   - `'spl'`: pass `mint` (base58 token mint) + `amountRaw` (base-units bigint string).
 *
 * the discriminator is set at enqueue time and read by the popup + the resolver to dispatch
 * to the right transfer helper.
 */
export type McpSendSolRequestMeta = {
  id: string;
  kind: 'native' | 'spl';
  to: string;
  /** lamports (native only). bigint as decimal string for safer JSON shipping. */
  lamports?: string;
  /** SPL mint (base58). present iff kind === 'spl'. */
  mint?: string;
  /** SPL amount in base-units (bigint string). present iff kind === 'spl'. */
  amountRaw?: string;
  /** caller hint shown in the popup (e.g. mcp client name from initialize). */
  callerHint?: string;
  /** sender Solana address, resolved at enqueue time so the popup shows it. */
  fromAddress: string;
  enqueuedAtMs: number;
};

export type McpSendSolResult = {
  /** Solana tx signature (base58). */
  signature: string;
  /** sender address that signed, for the caller to sanity-check. */
  signerAddress: string;
};

type PendingSendSol = McpSendSolRequestMeta & {
  resolve: (r: McpSendSolResult) => void;
  reject: (e: Error) => void;
};

const queue = new Map<string, PendingSendSol>();
let nextId = 1;

export function enqueueMcpSendSol(
  req: Omit<McpSendSolRequestMeta, 'id' | 'enqueuedAtMs' | 'kind'>,
): Promise<McpSendSolResult> {
  // discriminate on which fields are present. SPL = (mint + amountRaw); native = (lamports).
  const isSpl = typeof req.mint === 'string' && req.mint.length > 0;
  if (isSpl) {
    if (typeof req.amountRaw !== 'string' || !/^\d+$/.test(req.amountRaw)) {
      return Promise.reject(new Error('SPL transfer requires `amountRaw` (positive decimal string)'));
    }
    let amount: bigint;
    try {
      amount = BigInt(req.amountRaw);
    } catch {
      return Promise.reject(new Error(`invalid amountRaw: ${req.amountRaw}`));
    }
    if (amount <= 0n) return Promise.reject(new Error('amountRaw must be positive'));
    if (req.lamports != null) {
      return Promise.reject(new Error('SPL transfer cannot also set `lamports`; pass either lamports OR (mint + amountRaw)'));
    }
  } else {
    if (typeof req.lamports !== 'string' || !/^\d+$/.test(req.lamports)) {
      return Promise.reject(new Error('native transfer requires `lamports` (positive decimal string)'));
    }
    let lamports: bigint;
    try {
      lamports = BigInt(req.lamports);
    } catch {
      return Promise.reject(new Error(`invalid lamports: ${req.lamports}`));
    }
    if (lamports <= 0n) return Promise.reject(new Error('lamports must be positive'));
    if (lamports > MAX_LAMPORTS) {
      return Promise.reject(new Error(`lamports ${lamports} exceeds sanity cap ${MAX_LAMPORTS}`));
    }
    if (req.amountRaw != null || req.mint != null) {
      return Promise.reject(new Error('native transfer cannot set `mint`/`amountRaw`; pass either lamports OR (mint + amountRaw)'));
    }
  }

  const id = `mcp-sendsol-${Date.now()}-${nextId++}`;
  const meta: McpSendSolRequestMeta = {
    id,
    kind: isSpl ? 'spl' : 'native',
    to: req.to,
    lamports: isSpl ? undefined : req.lamports,
    mint: isSpl ? req.mint : undefined,
    amountRaw: isSpl ? req.amountRaw : undefined,
    callerHint: req.callerHint,
    fromAddress: req.fromAddress,
    enqueuedAtMs: Date.now(),
  };

  return new Promise<McpSendSolResult>((resolve, reject) => {
    queue.set(id, { ...meta, resolve, reject });
    void openMcpSendSolPopup(id);
  });
}

export function getPendingMcpSendSolMeta(id: string): McpSendSolRequestMeta | null {
  const p = queue.get(id);
  if (!p) return null;
  const { resolve: _r, reject: _j, ...meta } = p;
  void _r;
  void _j;
  return meta;
}

export function resolvePendingMcpSendSol(id: string, result: McpSendSolResult): void {
  const p = queue.get(id);
  if (!p) throw new Error(`No pending mcp sendSol request: ${id}`);
  queue.delete(id);
  p.resolve(result);
}

export function rejectPendingMcpSendSol(id: string, reason = 'user_canceled'): void {
  const p = queue.get(id);
  if (!p) throw new Error(`No pending mcp sendSol request: ${id}`);
  queue.delete(id);
  p.reject(new Error(reason));
}

async function openMcpSendSolPopup(id: string): Promise<void> {
  try {
    const { left, top } = await getPopupPosition(POPUP_WIDTH);
    await chrome.windows.create({
      url: chrome.runtime.getURL(`index.html?mcpsendsol=${encodeURIComponent(id)}`),
      type: 'popup',
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
      left,
      top,
    });
  } catch (e) {
    rejectPendingMcpSendSol(id, e instanceof Error ? e.message : String(e));
  }
}
