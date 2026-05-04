/** background -> content script -> page: EIP-1193 style bridge responses */
export type DappBridgeOk = { ok: true; result?: unknown };
export type DappBridgeErr = { ok: false; error: string; code?: number };
export type DappBridgeResponse = DappBridgeOk | DappBridgeErr;

export const RPC_USER_REJECTED = 4001;
export const RPC_UNSUPPORTED_METHOD = 4200;
