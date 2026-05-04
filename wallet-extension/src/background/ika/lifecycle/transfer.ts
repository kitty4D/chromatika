import {
  IkaTransaction,
  type ZeroTrustDWallet,
  type ImportedKeyDWallet,
} from '@ika.xyz/sdk';
import { Transaction } from '@mysten/sui/transactions';
import { getSession } from '@/background/session';
import type { CurveKey } from '@/background/session';
import { requireSuiAndIkaCoins } from '@/background/ika/coins';
import { executeSuiTransaction } from '@/background/sui/execute-transaction';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';
import { saveDwalletMeta } from '@/background/storage-meta';
import { getRequiredCoinAmounts } from '@/background/ika/pricing';
import {
  extractEncryptedShareIdFromEvents,
  idsFromEvents,
} from './internal';
import {
  ensureCurveEncryptionKeyReady,
  registerEncryptionKeyOnChain,
} from './encryption-key';

/**
 * sender side: re-encrypt the user's share for a recipient address.
 *
 * the recipient must have already registered an encryption key on ika.
 * after this tx, the recipient can call `acceptTransferredDWallet` using
 * the sender's encryption key (which they must know out-of-band, NOT fetched
 * from the network - this is ika's MITM prevention model).
 *
 * returns the tx digest so the sender can share it with the recipient
 * as proof + reference for the destination encrypted share id.
 */
export async function transferDWallet(
  curveKey: CurveKey,
  recipientSuiAddress: string,
): Promise<{ txDigest: string; dwalletId: string }> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');

  const meta = s.dwalletMeta[curveKey];
  if (!meta?.dwalletId) throw new Error('No dWallet for this curve - create one first');
  if (!meta.encryptedUserSecretKeyShareId) {
    throw new Error('Missing encrypted share id - dWallet setup may be incomplete');
  }

  const dwalletId = meta.dwalletId;
  const owner = getSuiFeePayerSuiAddress(s);
  const keys = s.ikaShareKeys[curveKey];

  const dWallet = await s.ikaClient.getDWallet(dwalletId);
  const encShare = await s.ikaClient.getEncryptedUserSecretKeyShare(
    meta.encryptedUserSecretKeyShareId,
  );

  const { ikaAmount, suiAmount } = await getRequiredCoinAmounts(s.ikaClient);
  const { suiCoinId, ikaCoinId } = await requireSuiAndIkaCoins(
    s.suiClient,
    s.ikaClient.ikaConfig,
    owner,
    { minSuiProtocolSplitMist: suiAmount, session: s },
  );

  const tx = new Transaction();
  const ikaTx = new IkaTransaction({
    ikaClient: s.ikaClient,
    transaction: tx as never,
    userShareEncryptionKeys: keys,
  });
  const splitIka = tx.splitCoins(tx.object(ikaCoinId), [ikaAmount]);
  const splitSui = tx.splitCoins(tx.object(suiCoinId), [suiAmount]);
  await ikaTx.requestReEncryptUserShareFor({
    dWallet: dWallet as ZeroTrustDWallet | ImportedKeyDWallet,
    sourceEncryptedUserSecretKeyShare: encShare,
    destinationEncryptionKeyAddress: recipientSuiAddress,
    ikaCoin: splitIka[0],
    suiCoin: splitSui[0],
  });
  // ika takes coins by &mut ref - transfer leftover back to sender
  tx.transferObjects([splitIka[0], splitSui[0]], owner);

  const result = await executeSuiTransaction(s, tx, { include: { effects: true, events: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }

  const digest = (result as { digest?: string }).digest ?? 'unknown';

  // sender no longer holds the active share for this dWallet locally
  s.dwalletMeta[curveKey] = { baseChain: s.activeVaultBaseChain };
  await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);

  return { txDigest: digest, dwalletId };
}

/**
 * get the sender's encryption key address - this is what the recipient
 * needs to know out-of-band to complete the transfer.
 *
 * returns the Sui address that was used to register the encryption key
 * (i.e. fee payer Sui address from `getSuiFeePayerSuiAddress`), which the recipient must verify
 * independently to prevent MITM.
 */
export function getSenderEncryptionKeyAddress(): string {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  return getSuiFeePayerSuiAddress(s);
}

/**
 * recipient side: accept a dWallet share that was transferred to us.
 *
 * the sender must have already called `transferDWallet` (requestReEncryptUserShareFor).
 * we need:
 *   - dwalletId: the dWallet being transferred
 *   - senderEncryptionKeyAddress: the sender's Sui address (known out-of-band!)
 *   - sourceEncryptedShareId: the sender's original encrypted share id
 *   - destEncryptedShareId: the new encrypted share id created by the re-encryption tx
 *
 * IMPORTANT: the recipient must verify `senderEncryptionKeyAddress` out-of-band (same chars the sender gave you).
 * the client then loads the on-chain EncryptionKey object for that address to build the PTB - verify first, then fetch.
 */
export async function acceptTransferredDWallet(
  curveKey: CurveKey,
  dwalletId: string,
  senderEncryptionKeyAddress: string,
  sourceEncryptedShareId: string,
  destEncryptedShareId: string,
): Promise<{ phase: string }> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');

  const keys = s.ikaShareKeys[curveKey];

  if (s.dwalletMeta[curveKey]?.registeredEncryptionKey) {
    await ensureCurveEncryptionKeyReady(curveKey);
  } else {
    await registerEncryptionKeyOnChain(curveKey);
  }

  const dWallet = await s.ikaClient.getDWallet(dwalletId);
  const sourceEncObj = await s.ikaClient.getEncryptedUserSecretKeyShare(sourceEncryptedShareId);
  const destEncObj = await s.ikaClient.getEncryptedUserSecretKeyShare(destEncryptedShareId);
  // verify sender address out-of-band first; this fetch loads the on-chain key object for the PTB
  const sourceEncryptionKey = await s.ikaClient.getActiveEncryptionKey(senderEncryptionKeyAddress);

  const tx = new Transaction();
  const ikaTx = new IkaTransaction({
    ikaClient: s.ikaClient,
    transaction: tx as never,
    userShareEncryptionKeys: keys,
  });

  await ikaTx.acceptEncryptedUserShare({
    dWallet: dWallet as ZeroTrustDWallet,
    sourceEncryptionKey,
    sourceEncryptedUserSecretKeyShare: sourceEncObj,
    destinationEncryptedUserSecretKeyShare: destEncObj,
  });

  const result = await executeSuiTransaction(s, tx, { include: { effects: true, events: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }

  s.dwalletMeta[curveKey] ??= { baseChain: s.activeVaultBaseChain };
  s.dwalletMeta[curveKey]!.dwalletId = dwalletId;
  s.dwalletMeta[curveKey]!.encryptedUserSecretKeyShareId = destEncryptedShareId;
  await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);

  const d2 = await s.ikaClient.getDWallet(dwalletId);
  const kind = (d2.state as { $kind: string }).$kind;
  return { phase: kind ?? 'unknown' };
}

/**
 * after a transfer tx, inspect events to help the recipient pick `destEncryptedShareId`.
 * IDs are hints only, confirm against what the sender shared out-of-band.
 */
export async function parseTransferTxEncryptedShareHints(digest: string): Promise<{
  candidateEncryptedShareIds: string[];
  objectIdsFromEvents: string[];
}> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');

  const res = await s.suiClient.getTransaction({
    digest,
    include: { events: true },
  });
  if (res.$kind !== 'Transaction') {
    throw new Error('Transaction not found or failed');
  }
  const rawEvents = (res.Transaction.events ?? []).map((e) => ({
    type: e.eventType ?? null,
    parsedJson: e.json as unknown,
  }));
  const objectIdsFromEvents = idsFromEvents(rawEvents);
  const encHint = extractEncryptedShareIdFromEvents(rawEvents);
  const candidateEncryptedShareIds = encHint
    ? [encHint, ...objectIdsFromEvents.filter((id) => id !== encHint)]
    : [...objectIdsFromEvents];
  return {
    candidateEncryptedShareIds: [...new Set(candidateEncryptedShareIds)],
    objectIdsFromEvents,
  };
}
