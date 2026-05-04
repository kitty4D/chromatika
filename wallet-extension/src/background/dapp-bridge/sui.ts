import { toSerializedSignature } from '@mysten/sui/cryptography';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { getSession } from '@/background/session';
import { signMessageSol } from '@/background/chains/signing';
import {
  getDwalletEd25519PublicKey,
  getDwalletEd25519PublicKeyForDwalletId,
} from '@/background/chains/solana';
import {
  buildDappSuiTransaction,
  executeDappSuiSignedTransaction,
  parseSuiDappTransactionPayload,
  resolveSuiDappSenderAddress,
  signBuiltSuiTransactionBytes,
} from '@/background/chains/sui-dapp-tx';
import { buildSuiPersonalMessageDigest } from '@/background/chains/sui-personal-message';
import { resolveEd25519DwalletIdForDapp } from '@/background/dapp-dwallet-resolve';
import { canUseMethod, getPermission } from '@/background/dapp-permissions';
import {
  ensureNonEvmConnectedForOrigin,
  type BridgeCtx,
  type HandlerResult,
} from './internal';

/**
 * convert a 0x-optional 128-char hex ed25519 signature (output of `signMessageSol`) into the
 * raw 64-byte form `toSerializedSignature` wants. same shape used in `chains/sui-dapp-tx.ts`.
 */
function hexEd25519SigToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '');
  if (h.length !== 128) throw new Error('expected 64-byte ed25519 signature (hex)');
  return Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

export async function handleSuiMethod(ctx: BridgeCtx): Promise<HandlerResult> {
  const { method, params, origin, consentMode, log } = ctx;

  if (method === 'sui_connect') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const conn = await ensureNonEvmConnectedForOrigin(origin, 'sui', method, log);
    if (!conn.ok) return conn;
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    const address = await resolveSuiDappSenderAddress({ ed25519DwalletId: edId });
    await log(true);
    return { ok: true, result: { address } };
  }

  /** wallet standard: raw ed25519 pubkey bytes for the connected Sui account (no extra prompt). */
  if (method === 'sui_walletStandardAccount') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permitted = await getPermission(origin);
    if (!permitted?.scope.accounts) {
      return { ok: false, error: 'connect with sui_connect first' };
    }
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    const address = await resolveSuiDappSenderAddress({ ed25519DwalletId: edId });
    const publicKey = Array.from(await getDwalletEd25519PublicKeyForDwalletId(edId));
    return { ok: true, result: { address, publicKey } };
  }

  if (method === 'sui_getAccounts') {
    const s = getSession();
    if (!s) return { ok: true, result: { accounts: [] } };
    const permitted = await getPermission(origin);
    if (!permitted?.scope.accounts) return { ok: true, result: { accounts: [] } };
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    const address = await resolveSuiDappSenderAddress({ ed25519DwalletId: edId });
    return { ok: true, result: { accounts: [address] } };
  }

  // sui dapp personal_message: signs the raw message bytes with ika Ed25519 + SHA512 (signMessageSol).
  // Mysten standard signPersonalMessage signs `BLAKE2b-256(intent_prefix || bcs::vector<u8>(message))`
  // with ed25519, then base64-encodes a flag-prefixed serialized signature. chromatika v0 used to
  // sign the raw message bytes via the ika MPC ed25519 path - that produces a sig that does NOT
  // verify under Mysten's standard verifier, so dapps using `verifyPersonalMessageSignature` (most
  // of them) and Seal's SessionKey flow rejected those signatures. now ported to the Mysten standard,
  // matching the tx-signing path at `chains/sui-dapp-tx.ts:signBuiltSuiTransactionBytes`.
  if (method === 'sui_signPersonalMessage') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, method)) {
      return { ok: false, error: 'Permission denied for sui_signPersonalMessage' };
    }
    if (!permission?.scope.accounts) {
      return { ok: false, error: 'connect with sui_connect before signing' };
    }
    const p = ((params ?? [])[0] as { message?: string | number[] } | undefined);
    let msgBytes: Uint8Array;
    if (Array.isArray(p?.message)) {
      msgBytes = Uint8Array.from(p.message as number[]);
    } else if (typeof p?.message === 'string') {
      msgBytes = Uint8Array.from(
        p.message.replace(/^0x/i, '').match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
      );
    } else {
      msgBytes = new Uint8Array(0);
    }
    const edId = await resolveEd25519DwalletIdForDapp(origin);

    // Mysten flow: BCS-encode message as vector<u8>, prepend PersonalMessage intent, BLAKE2b-256 hash.
    // ika MPC then signs that 32-byte digest with ed25519.
    const digest = buildSuiPersonalMessageDigest(msgBytes);
    const { signature: mpcHex } = await signMessageSol(digest, edId ? { ed25519DwalletId: edId } : undefined);
    const sigBytes = hexEd25519SigToBytes(mpcHex);
    const pubBytes = edId
      ? await getDwalletEd25519PublicKeyForDwalletId(edId)
      : await getDwalletEd25519PublicKey();
    const serialized = toSerializedSignature({
      signature: sigBytes,
      signatureScheme: 'ED25519',
      publicKey: new Ed25519PublicKey(pubBytes),
    });

    // base64 of the raw user-supplied message bytes - the dapp re-derives the digest itself
    const messageB64 = btoa(String.fromCharCode(...msgBytes));
    return { ok: true, result: { bytes: messageB64, signature: serialized } };
  }

  if (method === 'sui_signTransaction') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, method)) {
      return { ok: false, error: 'Permission denied for sui_signTransaction' };
    }
    if (!permission?.scope.accounts) {
      return { ok: false, error: 'connect with sui_connect before signing' };
    }
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    try {
      const tx = parseSuiDappTransactionPayload((params ?? [])[0]);
      const built = await buildDappSuiTransaction(tx, { ed25519DwalletId: edId });
      const signed = await signBuiltSuiTransactionBytes(built, { ed25519DwalletId: edId });
      await log(true);
      return { ok: true, result: signed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log(false, msg);
      return { ok: false, error: msg };
    }
  }

  if (method === 'sui_signAndExecuteTransaction') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const permission = await getPermission(origin);
    if (consentMode === 'strict' && !canUseMethod(permission, method)) {
      return { ok: false, error: 'Permission denied for sui_signAndExecuteTransaction' };
    }
    if (!permission?.scope.accounts) {
      return { ok: false, error: 'connect with sui_connect before signing' };
    }
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    try {
      const tx = parseSuiDappTransactionPayload((params ?? [])[0]);
      const built = await buildDappSuiTransaction(tx, { ed25519DwalletId: edId });
      const { signature } = await signBuiltSuiTransactionBytes(built, { ed25519DwalletId: edId });
      const result = await executeDappSuiSignedTransaction(tx, built, signature);
      await log(true);
      // tx-record so the activity feed picks up dapp-initiated Sui sends with origin captured.
      try {
        const digest = (result as { digest?: string } | null)?.digest;
        if (digest) {
          const { recordSignedTx } = await import('@/background/services/tx-record');
          await recordSignedTx({
            txHash: digest,
            origin,
            chainId: 'sui-' + s.network,
            vaultId: s.activeVaultId,
            timestampMs: Date.now(),
            kind: 'sui-send',
          });
        }
      } catch (recErr) {
        console.warn('[chromatika tx-record] sui-send (dapp) origin record failed', recErr);
      }
      return { ok: true, result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log(false, msg);
      return { ok: false, error: msg };
    }
  }

  return null;
}
