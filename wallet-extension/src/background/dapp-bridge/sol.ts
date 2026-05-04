import { getSession } from '@/background/session';
import { signMessageSol } from '@/background/chains/signing';
import { signSolanaTransactionWire } from '@/background/chains/solana-tx-sign';
import {
  getDwalletEd25519PublicKeyForDwalletId,
  getSolanaAddressForDwalletId,
} from '@/background/chains/solana';
import { resolveEd25519DwalletIdForDapp } from '@/background/dapp-dwallet-resolve';
import { canUseMethod, getPermission } from '@/background/dapp-permissions';
import { solanaWireInvokesEncryptProgram } from '@/background/encrypt/encrypt-solana-program-detect';
import {
  ensureNonEvmConnectedForOrigin,
  solanaWireFromBridgeParam,
  type BridgeCtx,
  type HandlerResult,
} from './internal';

export async function handleSolMethod(ctx: BridgeCtx): Promise<HandlerResult> {
  const { method, params, origin, consentMode, log } = ctx;

  if (method === 'solana_connect') {
    console.warn('[chromatika][solana_connect] begin', { origin });
    const s = getSession();
    if (!s) {
      console.warn('[chromatika][solana_connect] no session');
      return { ok: false, error: 'Wallet locked' };
    }
    const conn = await ensureNonEvmConnectedForOrigin(origin, 'solana', method, log);
    console.warn('[chromatika][solana_connect] ensureNonEvmConnected result', conn);
    if (!conn.ok) return conn;
    try {
      const edId = await resolveEd25519DwalletIdForDapp(origin);
      console.warn('[chromatika][solana_connect] edId', { edId });
      const address = await getSolanaAddressForDwalletId(edId);
      console.warn('[chromatika][solana_connect] address', { address });
      await log(true);
      return { ok: true, result: { address, publicKey: address } };
    } catch (err) {
      console.warn('[chromatika][solana_connect] address resolve failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  if (method === 'solana_walletStandardAccount') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permitted = await getPermission(origin);
    if (!permitted?.scope.accounts) {
      return { ok: false, error: 'connect with solana_connect first' };
    }
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    const address = await getSolanaAddressForDwalletId(edId);
    const publicKey = Array.from(await getDwalletEd25519PublicKeyForDwalletId(edId));
    return { ok: true, result: { address, publicKey } };
  }

  if (method === 'solana_disconnect') {
    return { ok: true, result: {} };
  }

  if (method === 'solana_signMessage') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, method)) {
      return { ok: false, error: 'Permission denied for solana_signMessage' };
    }
    if (!permission?.scope.accounts) {
      return { ok: false, error: 'connect with solana_connect before signing' };
    }
    const hexMsg = (params ?? [])[0] as string;
    const msgBytes = Uint8Array.from(
      hexMsg.replace(/^0x/i, '').match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
    );
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    const { signature } = await signMessageSol(msgBytes, { ed25519DwalletId: edId });
    return { ok: true, result: { signature } };
  }

  if (method === 'solana_signTransaction') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, method)) {
      return { ok: false, error: 'Permission denied for solana_signTransaction' };
    }
    if (!permission?.scope.accounts) {
      return { ok: false, error: 'connect with solana_connect before signing' };
    }
    const raw = (params ?? [])[0];
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    try {
      const wire = solanaWireFromBridgeParam(raw);
      const encryptProgram = solanaWireInvokesEncryptProgram(wire);
      const signed = await signSolanaTransactionWire(wire, { ed25519DwalletId: edId });
      await log(true, encryptProgram ? 'encrypt_program_invoked' : undefined, {
        solanaEncryptProgram: encryptProgram || undefined,
      });
      return { ok: true, result: { wire: Array.from(signed) } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log(false, msg);
      return { ok: false, error: msg };
    }
  }

  if (method === 'solana_signAllTransactions') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, method)) {
      return { ok: false, error: 'Permission denied for solana_signAllTransactions' };
    }
    if (!permission?.scope.accounts) {
      return { ok: false, error: 'connect with solana_connect before signing' };
    }
    const list = (params ?? [])[0];
    if (!Array.isArray(list)) {
      return { ok: false, error: 'solana_signAllTransactions expects an array of transactions' };
    }
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    try {
      const out: { wire: number[] }[] = [];
      let anyEncrypt = false;
      for (const item of list) {
        const wire = solanaWireFromBridgeParam(item);
        if (solanaWireInvokesEncryptProgram(wire)) anyEncrypt = true;
        const signed = await signSolanaTransactionWire(wire, { ed25519DwalletId: edId });
        out.push({ wire: Array.from(signed) });
      }
      await log(true, anyEncrypt ? 'encrypt_program_invoked' : undefined, {
        solanaEncryptProgram: anyEncrypt || undefined,
      });
      return { ok: true, result: out };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log(false, msg);
      return { ok: false, error: msg };
    }
  }

  return null;
}
