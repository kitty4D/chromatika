import type { DappBridgeResponse } from '@/lib/dapp-bridge-result';
import { getSession } from '@/background/session';
import { recordBridgeTelemetry } from '@/background/dapp-telemetry';
import { getDappConsentMode } from '@/background/dapp-consent-mode';
import { ensureUnlockedSessionFromCache } from '@/background/wallet-service';
import {
  parseWalletPermissionObjectKeys,
  type BridgeCtx,
  type DappPageRequest,
  type HandlerResult,
} from './dapp-bridge/internal';
import { handleEthMethod, handleEthRpcProxy } from './dapp-bridge/eth';
import { handleAptosMethod } from './dapp-bridge/aptos';
import { handleSolMethod } from './dapp-bridge/sol';
import { handleSuiMethod } from './dapp-bridge/sui';
import { handleBtcMethod } from './dapp-bridge/btc';
import { handleX402Method } from './dapp-bridge/x402';

export type { DappPageRequest };
export { parseWalletPermissionObjectKeys };

/**
 * handle EIP-1193 - style calls from an injected page script (via content script).
 * origin is the tab page origin (validated in content script).
 *
 * MV3 service workers can be evicted at any time, losing in-memory session state.
 * we attempt to auto-recover from the unlock cache before checking getSession(),
 * so dapp requests don't silently fail when the worker wakes from suspension.
 */
export async function handleDappRequest(
  inner: DappPageRequest,
  _sender?: chrome.runtime.MessageSender,
): Promise<DappBridgeResponse> {
  const { method, params } = inner;
  const origin = _sender?.origin ?? _sender?.url ?? 'unknown';

  // if the service worker was evicted and restarted, session is null.
  // try to re-hydrate from the encrypted unlock cache before anything else.
  if (!getSession()) {
    await ensureUnlockedSessionFromCache();
  }

  const log: BridgeCtx['log'] = async (ok, reason, extra) => {
    await recordBridgeTelemetry({ at: Date.now(), origin, method, ok, reason, ...extra });
  };

  try {
    const consentMode = await getDappConsentMode();
    const ctx: BridgeCtx = { method, params, origin, consentMode, log };

    // dispatch order matches the original switch: explicit EVM branches first,
    // then Aptos, then EVM read-only RPC proxy, then Solana, Sui, Bitcoin.
    const handlers: Array<(ctx: BridgeCtx) => Promise<HandlerResult>> = [
      handleX402Method,
      handleEthMethod,
      handleAptosMethod,
      handleEthRpcProxy,
      handleSolMethod,
      handleSuiMethod,
      handleBtcMethod,
    ];
    for (const h of handlers) {
      const r = await h(ctx);
      if (r) return r;
    }

    return { ok: false, error: `Unsupported method: ${method}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log(false, msg);
    return { ok: false, error: msg };
  }
}
