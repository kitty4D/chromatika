import { getSession } from '@/background/session';
import {
  getAptosAddressForDwalletId,
  getAptosNetworkInfoForDapp,
  getAptosPublicKeyHexForDwalletId,
  signAndSubmitAptosFromDapp,
  signAptosTransactionFromBcs,
  signMessageAptos,
} from '@/background/chains/aptos';
import { resolveEd25519DwalletIdForDapp } from '@/background/dapp-dwallet-resolve';
import { canUseMethod, getPermission } from '@/background/dapp-permissions';
import {
  ensureNonEvmConnectedForOrigin,
  type BridgeCtx,
  type HandlerResult,
} from './internal';

export async function handleAptosMethod(ctx: BridgeCtx): Promise<HandlerResult> {
  const { method, params, origin, consentMode, log } = ctx;

  if (method === 'aptos_connect') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const conn = await ensureNonEvmConnectedForOrigin(origin, 'aptos', method, log);
    if (!conn.ok) return conn;
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    const address = await getAptosAddressForDwalletId(edId);
    const publicKey = await getAptosPublicKeyHexForDwalletId(edId);
    await log(true);
    return { ok: true, result: { address, publicKey } };
  }

  if (method === 'aptos_account') {
    const s = getSession();
    if (!s) return { ok: true, result: null };
    const permitted = await getPermission(origin);
    if (!permitted?.scope.accounts) return { ok: true, result: null };
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    const address = await getAptosAddressForDwalletId(edId);
    const publicKey = await getAptosPublicKeyHexForDwalletId(edId);
    return { ok: true, result: { address, publicKey } };
  }

  if (method === 'aptos_isConnected') {
    const permitted = await getPermission(origin);
    return { ok: true, result: !!getSession() && !!permitted?.scope.accounts };
  }

  if (method === 'aptos_disconnect') {
    return { ok: true, result: {} };
  }

  if (method === 'aptos_network') {
    const info = await getAptosNetworkInfoForDapp();
    return { ok: true, result: info };
  }

  if (method === 'aptos_signMessage') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, method)) {
      return { ok: false, error: 'Permission denied for aptos_signMessage' };
    }
    if (!permission?.scope.accounts) {
      return { ok: false, error: 'connect with aptos_connect before signing' };
    }
    const p = (params ?? [])[0] as { message?: string; nonce?: string } | undefined;
    const message = p?.message ?? '';
    const nonce = p?.nonce ?? '';
    // aptos AIP-21 signing message format
    const fullMessage = `APTOS\nmessage: ${message}\nnonce: ${nonce}`;
    const msgBytes = new TextEncoder().encode(fullMessage);
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    const { signature } = await signMessageAptos(msgBytes, { ed25519DwalletId: edId });
    return { ok: true, result: { signature, fullMessage, message, nonce, prefix: 'APTOS' } };
  }

  if (method === 'aptos_signAndSubmitTransaction') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, method)) {
      return { ok: false, error: 'Permission denied for aptos_signAndSubmitTransaction' };
    }
    if (!permission?.scope.accounts) {
      return { ok: false, error: 'connect with aptos_connect before submitting' };
    }
    const raw = (params ?? [])[0];
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    try {
      const result = await signAndSubmitAptosFromDapp(raw, { ed25519DwalletId: edId });
      await log(true);
      // tx-record so the activity feed picks up the dapp-initiated send with origin captured.
      try {
        const hash = (result as { hash?: string } | null)?.hash;
        if (hash) {
          const session = getSession();
          if (session?.activeVaultId) {
            const { recordSignedTx } = await import('@/background/services/tx-record');
            await recordSignedTx({
              txHash: hash,
              origin,
              chainId: 'apt',
              vaultId: session.activeVaultId,
              timestampMs: Date.now(),
              kind: 'apt-send',
            });
          }
        }
      } catch (recErr) {
        console.warn('[chromatika tx-record] apt-send origin record failed', recErr);
      }
      return { ok: true, result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log(false, msg);
      return { ok: false, error: msg };
    }
  }

  /** AIP-62 `aptos:signTransaction` (SimpleTransaction BCS from dapp, authenticator BCS to page). */
  if (method === 'aptos_signTransaction') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, 'aptos_signAndSubmitTransaction')) {
      return { ok: false, error: 'Permission denied for aptos_signTransaction' };
    }
    if (!permission?.scope.accounts) {
      return { ok: false, error: 'connect with aptos_connect before signing transactions' };
    }
    const body = (params ?? [])[0] as { wire?: number[] } | undefined;
    const wire = body?.wire;
    if (!Array.isArray(wire) || wire.length === 0) {
      return { ok: false, error: 'aptos_signTransaction needs { wire: number[] } (SimpleTransaction BCS)' };
    }
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    try {
      const authenticatorBcs = await signAptosTransactionFromBcs(Uint8Array.from(wire), {
        ed25519DwalletId: edId,
      });
      await log(true);
      return { ok: true, result: { authenticatorBcs: Array.from(authenticatorBcs) } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log(false, msg);
      return { ok: false, error: msg };
    }
  }

  return null;
}
