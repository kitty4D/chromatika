import { getPopupPosition } from './popup-position';

export type DappApprovalKind =
  | 'connect'
  | 'switch_chain'
  | 'add_chain'
  | 'sign_personal'
  | 'sign_typed_data'
  | 'watch_token';

/** `evm` / omitted = SECP256K1 picker; non-EVM = ED25519 dWallet picker for that chain family. */
export type DappConnectFamily = 'evm' | 'sui' | 'solana' | 'aptos';

export type DappApprovalPayload = {
  kind: DappApprovalKind;
  origin: string;
  method: string;
  /** when `kind === 'connect'`, drives approval UI (EVM vs ED25519). */
  connectFamily?: DappConnectFamily;
  chainId?: number;
  requestedAddress?: string;
  requestedChainId?: number;
  messagePreview?: string;
  typedDataPreview?: string;
  addChain?: {
    chainId: number;
    chainName: string;
    rpcUrl: string;
    symbol: string;
    decimals: number;
    explorerUrl?: string;
  };
  /** EIP-747 token suggestion */
  watchToken?: {
    address: string;
    symbol: string;
    decimals: number;
    image?: string;
  };
};

/** result for any dapp approval; wallet ids used when `kind === 'connect'`. */
export type DappApprovalResult = {
  approved: boolean;
  secpDwalletId?: string;
  ed25519DwalletId?: string;
};

type PendingDappApproval = {
  id: string;
  payload: DappApprovalPayload;
  resolve: (result: DappApprovalResult) => void;
  reject: (err: Error) => void;
};

const queue = new Map<string, PendingDappApproval>();
let seq = 1;

const APPROVAL_POPUP_WIDTH = 420;

/**
 * same site + same chain switch often fires from multiple iframes (content script is all_frames).
 * share one popup + one user decision across duplicate RPCs instead of N windows.
 */
const inflightSwitchChain = new Map<string, Promise<DappApprovalResult>>();
const inflightAddChain = new Map<string, Promise<DappApprovalResult>>();

export function enqueueDappApproval(payload: DappApprovalPayload): Promise<DappApprovalResult> {
  if (payload.kind === 'switch_chain' && payload.requestedChainId != null) {
    const key = `${payload.origin}|${payload.requestedChainId}`;
    const hit = inflightSwitchChain.get(key);
    if (hit) return hit;
  }
  if (payload.kind === 'add_chain' && payload.addChain?.chainId != null) {
    const key = `${payload.origin}|${payload.addChain.chainId}`;
    const hit = inflightAddChain.get(key);
    if (hit) return hit;
  }

  const promise = new Promise<DappApprovalResult>((resolve, reject) => {
    const id = `dappapprove-${Date.now()}-${seq++}`;
    queue.set(id, { id, payload, resolve, reject });
    void (async () => {
      const pos = await getPopupPosition(APPROVAL_POPUP_WIDTH);
      chrome.windows.create({
        url: chrome.runtime.getURL(`index.html?dappreq=${encodeURIComponent(id)}`),
        type: 'popup',
        width: APPROVAL_POPUP_WIDTH,
        height: 520,
        ...pos,
      });
    })();
    setTimeout(() => {
      if (!queue.has(id)) return;
      queue.delete(id);
      reject(new Error('Approval timed out'));
    }, 5 * 60_000);
  });

  if (payload.kind === 'switch_chain' && payload.requestedChainId != null) {
    const key = `${payload.origin}|${payload.requestedChainId}`;
    inflightSwitchChain.set(key, promise);
    promise.finally(() => {
      if (inflightSwitchChain.get(key) === promise) inflightSwitchChain.delete(key);
    });
  }
  if (payload.kind === 'add_chain' && payload.addChain?.chainId != null) {
    const key = `${payload.origin}|${payload.addChain.chainId}`;
    inflightAddChain.set(key, promise);
    promise.finally(() => {
      if (inflightAddChain.get(key) === promise) inflightAddChain.delete(key);
    });
  }

  return promise;
}

export function getDappApprovalMeta(id: string): { id: string; payload: DappApprovalPayload } | null {
  const req = queue.get(id);
  if (!req) return null;
  return { id: req.id, payload: req.payload };
}

export function resolveDappApproval(id: string, result: DappApprovalResult): void {
  const req = queue.get(id);
  if (!req) throw new Error(`No pending dapp approval: ${id}`);
  queue.delete(id);
  req.resolve(result);
}

export function rejectDappApproval(id: string, reason: string): void {
  const req = queue.get(id);
  if (!req) throw new Error(`No pending dapp approval: ${id}`);
  queue.delete(id);
  req.reject(new Error(reason));
}
