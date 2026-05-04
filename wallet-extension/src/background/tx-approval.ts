/**
 * pending EVM transaction approval queue.
 * background parks transactions here while the popup collects user confirmation.
 */

import { getPopupPosition } from './popup-position';
import type { DecodedTx } from './tx-decode';

export type TxApprovalResult =
  | { kind: 'broadcast'; txHash: string }
  | { kind: 'sign-only'; signedRawTx: string; txHash: string };

export type TxApprovalRequest = {
  id: string;
  origin: string;
  chainId: number;
  /** raw params from dapp */
  from: string;
  to: string | null;
  value: string;          // hex
  data: string;           // hex
  gas: string | null;     // hex
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  gasPrice: string | null;
  nonce: string | null;
  /** pre-decoded for the popup */
  decoded: DecodedTx;
  /**
   * when true, the approve handler signs the tx but does NOT broadcast - resolves with the
   * signed serialized hex + tx hash so the caller (relayer / bundler / MCP signTransaction)
   * can broadcast through their own infrastructure. default `false` (broadcast path) keeps
   * the dapp `eth_sendTransaction` and wallet-UI `sendEvmTx` flows unchanged.
   */
  signOnly?: boolean;
  resolve: (result: TxApprovalResult) => void;
  reject: (err: Error) => void;
};

const queue = new Map<string, TxApprovalRequest>();
let seq = 1;

const APPROVAL_POPUP_WIDTH = 420;

export function enqueueTxApproval(
  req: Omit<TxApprovalRequest, 'id' | 'resolve' | 'reject'>,
): Promise<TxApprovalResult> {
  return new Promise((resolve, reject) => {
    const id = `txapprove-${Date.now()}-${seq++}`;
    queue.set(id, { ...req, id, resolve, reject });

    void (async () => {
      const pos = await getPopupPosition(APPROVAL_POPUP_WIDTH);
      chrome.windows.create({
        url: chrome.runtime.getURL(`index.html?txapprove=${encodeURIComponent(id)}`),
        type: 'popup',
        width: APPROVAL_POPUP_WIDTH,
        height: 580,
        ...pos,
      });
    })();

    // auto-reject after 5 min if ignored
    setTimeout(() => {
      if (queue.has(id)) {
        queue.delete(id);
        reject(new Error('Transaction approval timed out'));
      }
    }, 5 * 60_000);
  });
}

export function getTxApprovalMeta(id: string): Omit<TxApprovalRequest, 'resolve' | 'reject'> | null {
  const r = queue.get(id);
  if (!r) return null;
  const { resolve: _r, reject: _j, ...meta } = r;
  return meta;
}

export function resolveTxApproval(id: string, result: TxApprovalResult): void {
  const r = queue.get(id);
  if (!r) throw new Error(`No pending tx approval: ${id}`);
  queue.delete(id);
  r.resolve(result);
}

export function rejectTxApproval(id: string, reason: string): void {
  const r = queue.get(id);
  if (!r) throw new Error(`No pending tx approval: ${id}`);
  queue.delete(id);
  r.reject(new Error(reason));
}
