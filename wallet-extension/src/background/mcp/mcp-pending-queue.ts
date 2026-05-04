/**
 * in-memory queue for mcp signing requests that need user approval via the wallet popup.
 *
 * mirrors `passkey-pending-queue.ts` shape exactly so future maintenance can lean on the same
 * patterns. each enqueued request returns a Promise; the popup-mediated tRPC procedures (in
 * `routers/mcp.ts`) call `resolvePendingMcpSign` on approve or `rejectPendingMcpSign` on
 * cancel.
 *
 * threat model (v1): each sign request opens its own popup, no batching, no auto-approve, no
 * rate limiting. the user is expected to read the chain + bytes and consciously approve. a
 * compromised mcp client cannot bypass this gate; it can only spam requests, which the user
 * sees and can disable via Settings -> Agents -> disable.
 */

import { getPopupPosition } from '@/background/popup-position';

const MCP_POPUP_WIDTH = 420;
const MCP_POPUP_HEIGHT = 560;
const MAX_MESSAGE_HEX_LENGTH = 16_384; // 8 KiB of bytes, matches a reasonable upper bound for personal_sign / bytes signing.

export type McpSignChain = 'evm' | 'solana';

export type McpSignRequestMeta = {
  id: string;
  chain: McpSignChain;
  messageHex: string;
  /** for evm only: chainId to bind the signature to */
  evmChainId?: number;
  /** caller hint surfaced to the user (e.g. mcp client name from initialize) */
  callerHint?: string;
  enqueuedAtMs: number;
};

export type McpSignResult = {
  /** hex-encoded signature bytes (with or without 0x prefix; consumers handle either). */
  signatureHex: string;
  /** address / pubkey that signed, for the caller to verify against. */
  signerAddress: string;
  /** chain reflected back so consumers can sanity-check before using. */
  chain: McpSignChain;
};

type PendingMcpSign = McpSignRequestMeta & {
  resolve: (r: McpSignResult) => void;
  reject: (e: Error) => void;
};

const queue = new Map<string, PendingMcpSign>();
let nextId = 1;

export function enqueueMcpSign(
  req: Omit<McpSignRequestMeta, 'id' | 'enqueuedAtMs'>,
): Promise<McpSignResult> {
  if (req.messageHex.length > MAX_MESSAGE_HEX_LENGTH) {
    return Promise.reject(
      new Error(
        `mcp signMessage rejected: messageHex length ${req.messageHex.length} exceeds cap of ${MAX_MESSAGE_HEX_LENGTH}`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const id = `mcpsign-${Date.now()}-${nextId++}`;
    queue.set(id, {
      ...req,
      id,
      enqueuedAtMs: Date.now(),
      resolve,
      reject,
    });
    void openMcpApprovalPopup(`mcpapprove=${encodeURIComponent(id)}`);
  });
}

export function getPendingMcpSignMeta(id: string): McpSignRequestMeta | null {
  const r = queue.get(id);
  if (!r) return null;
  const { resolve: _r, reject: _j, ...meta } = r;
  void _r;
  void _j;
  return meta;
}

export function resolvePendingMcpSign(id: string, result: McpSignResult): void {
  const r = queue.get(id);
  if (!r) throw new Error(`No pending mcp sign request: ${id}`);
  queue.delete(id);
  r.resolve(result);
}

export function rejectPendingMcpSign(id: string, message: string): void {
  const r = queue.get(id);
  if (!r) throw new Error(`No pending mcp sign request: ${id}`);
  queue.delete(id);
  r.reject(new Error(message));
}

async function openMcpApprovalPopup(query: string): Promise<void> {
  const pos = await getPopupPosition(MCP_POPUP_WIDTH);
  chrome.windows.create({
    url: chrome.runtime.getURL(`index.html?${query}`),
    type: 'popup',
    width: MCP_POPUP_WIDTH,
    height: MCP_POPUP_HEIGHT,
    ...pos,
  });
}
