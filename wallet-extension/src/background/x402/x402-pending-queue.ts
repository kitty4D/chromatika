/**
 * in-memory queue for x402 payment requests waiting on user approval via the popup.
 *
 * mirrors `mcp-pending-queue.ts` shape exactly. the dispatcher (`x402-dispatch.ts`) calls
 * `enqueueX402Approval` after running the synchronous caps check; the popup shows the seller
 * + amount + USD estimate; on approve the popup-side tRPC procedure runs the signer and
 * resolves the queue with the signed PAYMENT-SIGNATURE header value. on reject it surfaces a
 * structured error so the caller (eventually the page's fetch wrapper) gets a clean failure.
 */

import { getPopupPosition } from '@/background/popup-position';
import type { PaymentRequirements } from './x402-types';

const X402_POPUP_WIDTH = 420;
const X402_POPUP_HEIGHT = 540;

export type X402PendingMeta = {
  id: string;
  enqueuedAtMs: number;
  /** PaymentRequirements parsed from the PAYMENT-REQUIRED header. */
  requirements: PaymentRequirements;
  /** lowercased host of the resource URL, for cap bucketing + UI display. */
  sellerHost: string;
  /** best-effort USD estimate at quote time. null if price waterfall failed. */
  estimatedUsd: number | null;
  /** caller-supplied display hint, usually the originating page URL or 'mcp:<agent>'. */
  callerHint: string | null;
  /**
   * receipt id created upfront so the popup can link to "see this in receipts" once settled.
   * the dispatcher passes the same id to `appendReceipt` after sign.
   */
  receiptId: string;
};

export type X402ApprovedResult = {
  /** pre-encoded value for the PAYMENT-SIGNATURE header (base64 of PaymentPayload envelope). */
  headerValue: string;
  /** ATA used for the source side; for receipt records + UI display. */
  sourceAta: string;
  /** ATA used for the destination side. */
  destAta: string;
  /** memo / nonce string placed in the Memo instruction. */
  memoText: string;
  /** echoes the receipt id from the meta so callers can update / display it. */
  receiptId: string;
};

type Pending = X402PendingMeta & {
  resolve: (r: X402ApprovedResult) => void;
  reject: (e: Error) => void;
};

const queue = new Map<string, Pending>();
let nextId = 1;

export function enqueueX402Approval(
  req: Omit<X402PendingMeta, 'id' | 'enqueuedAtMs'>,
): Promise<X402ApprovedResult> {
  return new Promise((resolve, reject) => {
    const id = `x402-${Date.now()}-${nextId++}`;
    queue.set(id, {
      ...req,
      id,
      enqueuedAtMs: Date.now(),
      resolve,
      reject,
    });
    void openX402ApprovalPopup(`x402approve=${encodeURIComponent(id)}`);
  });
}

export function getPendingX402Meta(id: string): X402PendingMeta | null {
  const r = queue.get(id);
  if (!r) return null;
  const { resolve: _r, reject: _j, ...meta } = r;
  void _r;
  void _j;
  return meta;
}

export function resolvePendingX402(id: string, result: X402ApprovedResult): void {
  const r = queue.get(id);
  if (!r) throw new Error(`No pending x402 request: ${id}`);
  queue.delete(id);
  r.resolve(result);
}

export function rejectPendingX402(id: string, message: string): void {
  const r = queue.get(id);
  if (!r) throw new Error(`No pending x402 request: ${id}`);
  queue.delete(id);
  r.reject(new Error(message));
}

async function openX402ApprovalPopup(query: string): Promise<void> {
  const pos = await getPopupPosition(X402_POPUP_WIDTH);
  chrome.windows.create({
    url: chrome.runtime.getURL(`index.html?${query}`),
    type: 'popup',
    width: X402_POPUP_WIDTH,
    height: X402_POPUP_HEIGHT,
    ...pos,
  });
}
