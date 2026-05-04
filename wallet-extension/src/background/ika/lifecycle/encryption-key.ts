import {
  IkaTransaction,
  UserShareEncryptionKeys,
} from '@ika.xyz/sdk';
import { Transaction } from '@mysten/sui/transactions';
import { getSession } from '@/background/session';
import type { CurveKey } from '@/background/session';
import { executeSuiTransaction } from '@/background/sui/execute-transaction';
import { saveDwalletMeta } from '@/background/storage-meta';
import { ikaRootSeedFromFeeKeypair, ikaRootSeedFromSolanaKeypair } from '@/background/keyring/hd';
import { persistVaultFromSession } from '@/background/wallet-service';
import { isDynamicFieldAddAlreadyExistsError, toCurve, u8ToB64 } from './internal';

async function markEncryptionKeyRegisteredLocally(curveKey: CurveKey): Promise<void> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  s.dwalletMeta[curveKey] ??= { baseChain: s.activeVaultBaseChain };
  s.dwalletMeta[curveKey]!.registeredEncryptionKey = true;
  await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);
}

function expectedCurveNumber(curveKey: CurveKey): number {
  return curveKey === 'SECP256K1' ? 0 : 2;
}

export async function assertActiveEncryptionKeyCurve(curveKey: CurveKey): Promise<void> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const keys = s.ikaShareKeys[curveKey];
  const address = keys.getSuiAddress();
  const expected = expectedCurveNumber(curveKey);
  const key = await s.ikaClient.getActiveEncryptionKey(address) as { curve?: number | string };
  const got = Number(key.curve);
  if (got !== expected) {
    throw new Error(
      `ENCRYPTION_KEY_CURVE_MISMATCH: active encryption key curve mismatch for ${curveKey}: on-chain key at ${address} has curve=${got}, expected=${expected}. ` +
      `This usually means that address already registered a different curve key. Use a fresh vault/account (or clear dev storage and re-onboard) before creating this dWallet curve.`,
    );
  }
}

export async function rotateCurveEncryptionKey(curveKey: CurveKey, encryptionKeyIndex: number): Promise<void> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  // pick the seed source by base chain - must mirror the seed factory in wallet-service.
  // Sui-base reuses the Sui fee payer (CLI parity); Solana-base reuses the Solana fee payer.
  // hardware-only paths (Sui Ledger or Solana Ledger / Trezor / MWA) cannot rotate locally because
  // they have no hot key to derive a new seed from.
  let seed: Uint8Array;
  if (s.activeVaultBaseChain === 'solana') {
    if (!s.solanaFeePayer) {
      throw new Error(
        'Rotating ika encryption keys on Solana base needs a hot Solana fee key in the vault — hardware-only fee payer cannot derive ika root seed',
      );
    }
    seed = ikaRootSeedFromSolanaKeypair(s.solanaFeePayer, encryptionKeyIndex);
  } else {
    if (s.suiLedgerFee) {
      throw new Error(
        'Rotating ika encryption keys needs a hot Sui fee key in the vault — Ledger-only fee payer cannot derive ika root seed',
      );
    }
    seed = ikaRootSeedFromFeeKeypair(s.suiKeypair, encryptionKeyIndex);
  }
  try {
    const curve = toCurve(curveKey);
    const next = await UserShareEncryptionKeys.fromRootSeedKey(seed, curve);
    s.ikaShareKeys[curveKey] = next;
    s.ikaShareKeysB64[curveKey] = u8ToB64(next.toShareEncryptionKeysBytes());
    s.dwalletMeta[curveKey] ??= { baseChain: s.activeVaultBaseChain };
    s.dwalletMeta[curveKey]!.registeredEncryptionKey = false;
    await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);
    await persistVaultFromSession();
  } finally {
    seed.fill(0);
  }
}

export async function ensureCurveEncryptionKeyReady(curveKey: CurveKey): Promise<void> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  try {
    await assertActiveEncryptionKeyCurve(curveKey);
  } catch (e) {
    const canAutoRotate =
      curveKey === 'ED25519' &&
      !s.dwalletMeta[curveKey]?.dwalletId &&
      String(e).includes('ENCRYPTION_KEY_CURVE_MISMATCH');
    if (!canAutoRotate) throw e;
    await rotateCurveEncryptionKey(curveKey, 1);
    await registerEncryptionKeyOnChain(curveKey);
    await assertActiveEncryptionKeyCurve(curveKey);
  }
}

export async function registerEncryptionKeyOnChain(curveKey: CurveKey, attempt = 0): Promise<{ ok: true }> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const curve = toCurve(curveKey);
  const keys = s.ikaShareKeys[curveKey];
  const tx = new Transaction();
  const ikaTx = new IkaTransaction({
    ikaClient: s.ikaClient,
    transaction: tx as never,
    userShareEncryptionKeys: keys,
  });
  await ikaTx.registerEncryptionKey({ curve });
  let result: Awaited<ReturnType<typeof executeSuiTransaction>>;
  try {
    result = await executeSuiTransaction(s, tx, { include: { effects: true, events: true } });
  } catch (e) {
    // GraphQL `simulateTransaction` fails before submit; same on-chain meaning as execute-time abort.
    if (isDynamicFieldAddAlreadyExistsError(e)) {
      try {
        await assertActiveEncryptionKeyCurve(curveKey);
      } catch (curveErr) {
        const canAutoRotate =
          curveKey === 'ED25519' &&
          !s.dwalletMeta[curveKey]?.dwalletId &&
          attempt < 1 &&
          String(curveErr).includes('ENCRYPTION_KEY_CURVE_MISMATCH');
        if (!canAutoRotate) throw curveErr;
        // existing vaults may have ED and SECP mapped to the same address / key slot.
        // rotate ED to an alternate deterministic index and retry registration once.
        await rotateCurveEncryptionKey(curveKey, 1);
        return registerEncryptionKeyOnChain(curveKey, attempt + 1);
      }
      await markEncryptionKeyRegisteredLocally(curveKey);
      return { ok: true };
    }
    throw e;
  }
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    if (isDynamicFieldAddAlreadyExistsError(err)) {
      try {
        await assertActiveEncryptionKeyCurve(curveKey);
      } catch (curveErr) {
        const canAutoRotate =
          curveKey === 'ED25519' &&
          !s.dwalletMeta[curveKey]?.dwalletId &&
          attempt < 1 &&
          String(curveErr).includes('ENCRYPTION_KEY_CURVE_MISMATCH');
        if (!canAutoRotate) throw curveErr;
        await rotateCurveEncryptionKey(curveKey, 1);
        return registerEncryptionKeyOnChain(curveKey, attempt + 1);
      }
      await markEncryptionKeyRegisteredLocally(curveKey);
      return { ok: true };
    }
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }
  await assertActiveEncryptionKeyCurve(curveKey);
  await markEncryptionKeyRegisteredLocally(curveKey);
  return { ok: true };
}
