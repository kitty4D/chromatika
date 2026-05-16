/**
 * send any Sui coin from a **dWallet's** Sui address (the ED25519 dWallet's derived address),
 * signed by ika MPC instead of the local vault fee-payer keypair.
 *
 * sibling to:
 *   - [`sui-send-native.ts`](./sui-send-native.ts) - sends SUI from the vault keypair (gas-coin path)
 *   - [`sui-send-coin.ts`](./sui-send-coin.ts) - sends any Sui coin from the vault keypair
 *
 * gas: the dWallet's Sui address pays its own gas with a SUI coin it owns at that address.
 * if the dWallet has no SUI, the transaction fails before signing - the user has to fund the
 * dWallet's Sui address with a tiny amount of SUI first. (sponsored-tx where the vault keypair
 * pays gas is doable but requires an additional partial signature step; left for follow-up if
 * users hit this often.)
 *
 * the heavy lifting (intent message + BLAKE2b digest + ika ED25519 sign + Mysten signature
 * serialization + signature verification) lives in [`sui-dapp-tx.ts`](./sui-dapp-tx.ts); we
 * reuse those helpers so the wallet-ui send and the dapp `sui_signTransaction` flow share the
 * same code path.
 */

import { blake2b } from '@noble/hashes/blake2.js';
import * as ed25519 from '@noble/ed25519';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { messageWithIntent } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { getSession } from '@/background/session';
import { getDwalletEd25519PublicKeyForDwalletId } from '@/background/chains/solana';
import {
  signBuiltSuiTransactionBytes,
  executeDappSuiSignedTransaction,
} from '@/background/chains/sui-dapp-tx';
import { getRequiredCoinAmounts } from '@/background/ika/pricing';
import {
  getSuiBalanceMist,
  getIkaBalanceBaseUnits,
} from '@/background/ika/coins';
import { getPresignPoolStatus } from '@/background/ika/presign-pool';

const NATIVE_SUI_COIN_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

/**
 * minimum SUI we need at the vault fee-payer's Sui address before kicking off an ika MPC sign.
 * matches `pickSuiCoinForIkaProtocolSplit`'s default `minMistInOtherCoinsForGas` (0.2 SUI) for
 * Sui network gas. checked preflight so the failure message points at the right address to fund.
 */
const MIN_VAULT_SUI_GAS_RESERVE_MIST = 250_000_000n; // 0.25 SUI

/**
 * how many presigns each refill batch creates. mirrors `replenishPool(key, count = 3)` in
 * `@/background/ika/presign-pool.ts`. used to size the IKA + SUI protocol-fee preflight check
 * so we surface a clear "vault needs more IKA / SUI" error BEFORE the inner refill PTB fails
 * with the cryptic "Insufficient coin balance for operation" Move runtime error.
 */
const PRESIGN_REFILL_BATCH = 3;

/**
 * extra IKA / SUI we want above the bare minimum so back-to-back signs in one session don't
 * trip the next refill. 50% buffer is generous but ika protocol fees are small in absolute
 * terms so this rarely strands meaningful balance.
 */
const PROTOCOL_FEE_BUFFER_PCT = 50n;

/**
 * gas headroom we reserve at the dWallet's Sui address. when sending native SUI, this is
 * subtracted from "max" so the gas coin still has enough left to pay network gas after the
 * splitCoins consumes the send amount. when sending non-native (IKA / USDC / etc.) from the
 * dWallet, the dWallet still needs a SUI coin of at least this size at its address to cover
 * gas - the asset being sent doesn't pay gas.
 */
export const DWALLET_SUI_GAS_RESERVE_MIST = 50_000_000n; // 0.05 SUI

function isLikelySuiAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(s.trim());
}

function mistToSuiDisplay(mist: bigint): string {
  return (Number(mist) / 1e9).toFixed(3);
}

/**
 * preflight: confirm the vault fee-payer's Sui address has enough SUI **and** IKA to cover an
 * ika MPC sign operation, including a presign-pool refill if the pool is empty. ika MPC on
 * Sui-base requires the vault keypair to pay both:
 *   - ika protocol fees in IKA (per-presign, multiplied by the refill batch size if the pool
 *     needs replenishing)
 *   - ika protocol fees in SUI plus Sui network gas for the refill / sign PTB
 *
 * if either is short, surface a clear error naming the vault address + the missing asset.
 * without this preflight the failure mode is the cryptic Move runtime error "Error in 1st
 * command, Insufficient coin balance for operation" which doesn't tell the user *what* coin
 * is short.
 */
async function assertVaultFundedForIkaSign(): Promise<void> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const vaultSuiAddr = s.suiKeypair.getPublicKey().toSuiAddress();

  // 1. on-chain pricing per presign (IKA + SUI). already has a 10% buffer baked in.
  const { ikaAmount, suiAmount } = await getRequiredCoinAmounts(s.ikaClient);

  // 2. size the requirement: if the ED25519 pool is empty / low, the next sign triggers a
  //    refill that creates `PRESIGN_REFILL_BATCH` presigns; otherwise we just need fees for
  //    the single sign PTB itself.
  let needsBatchRefill = true;
  try {
    const status = await getPresignPoolStatus();
    needsBatchRefill = (status.ED25519_EDDSA ?? 0) <= 0;
  } catch {
    // best-effort: when status read fails, assume worst case (need refill).
  }
  const protocolMultiplier = needsBatchRefill ? BigInt(PRESIGN_REFILL_BATCH) : 1n;
  const ikaNeededRaw = ikaAmount * protocolMultiplier;
  const suiProtocolNeededRaw = suiAmount * protocolMultiplier;
  // add the buffer: + (buffer% * required) / 100
  const ikaNeeded = ikaNeededRaw + (ikaNeededRaw * PROTOCOL_FEE_BUFFER_PCT) / 100n;
  const suiProtocolNeeded =
    suiProtocolNeededRaw + (suiProtocolNeededRaw * PROTOCOL_FEE_BUFFER_PCT) / 100n;

  // 3. read both vault balances.
  const [suiBalance, ikaBalance] = await Promise.all([
    getSuiBalanceMist(s.suiClient, vaultSuiAddr),
    getIkaBalanceBaseUnits(s.suiClient, s.ikaClient.ikaConfig, vaultSuiAddr),
  ]);

  // 4. SUI shortfall = protocol-fee SUI (per batch) + 0.25 SUI for network gas.
  const totalSuiNeeded = suiProtocolNeeded + MIN_VAULT_SUI_GAS_RESERVE_MIST;
  if (suiBalance < totalSuiNeeded) {
    throw new Error(
      `Vault fee-payer Sui address needs more SUI for the ika MPC sign${needsBatchRefill ? ' + presign-pool refill' : ''}. ` +
        `Have ${mistToSuiDisplay(suiBalance)} SUI, need ~${mistToSuiDisplay(totalSuiNeeded)} SUI ` +
        `(${mistToSuiDisplay(suiProtocolNeeded)} for protocol fees${needsBatchRefill ? ` × ${PRESIGN_REFILL_BATCH} presigns` : ''} + ${mistToSuiDisplay(MIN_VAULT_SUI_GAS_RESERVE_MIST)} for network gas). ` +
        `Fund ${vaultSuiAddr} and retry.`,
    );
  }

  // 5. IKA shortfall.
  if (ikaBalance < ikaNeeded) {
    const ikaDisplay = (raw: bigint) => (Number(raw) / 1e9).toFixed(4);
    throw new Error(
      `Vault fee-payer Sui address needs more IKA for the ika MPC sign${needsBatchRefill ? ' + presign-pool refill' : ''}. ` +
        `Have ${ikaDisplay(ikaBalance)} IKA, need ~${ikaDisplay(ikaNeeded)} IKA ` +
        `(${ikaDisplay(ikaNeededRaw)} base${needsBatchRefill ? ` × ${PRESIGN_REFILL_BATCH} presigns` : ''} + ${PROTOCOL_FEE_BUFFER_PCT}% buffer). ` +
        `Acquire IKA at ${vaultSuiAddr} and retry. (IKA tokens cannot be sent via this wallet UI yet; ` +
        `use a DEX or the IKA staking screen.)`,
    );
  }
}

/**
 * send `baseUnits` of `coinType` to `to` from a dWallet's Sui address, signed by ika MPC.
 *
 * three coin-pick branches:
 *  - native SUI: use `tx.splitCoins(tx.gas, ...)`. the gas coin is implicitly an owned coin at
 *    the sender's Sui address (= the dWallet's), so we never need to fetch coin objects.
 *  - non-native single coin: find one owned coin of `coinType` covering the amount.
 *  - non-native split across many coins: merge enough coins to cover, then split + transfer.
 *
 * returns the executed transaction digest.
 */
export async function sendSuiFromDwallet(
  coinType: string,
  dwalletId: string,
  to: string,
  baseUnits: bigint,
): Promise<string> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const dest = to.trim();
  if (!isLikelySuiAddress(dest)) throw new Error('Invalid Sui address (expect 0x + 64 hex chars)');
  if (baseUnits <= 0n) throw new Error('Amount must be positive');

  const normalizedType = coinType.trim();
  if (!normalizedType) throw new Error('coinType is required');

  // preflight: vault keypair must have SUI + IKA for ika protocol fees + gas on the sign PTB
  // (and on the presign-pool refill PTB when the pool is empty).
  await assertVaultFundedForIkaSign();

  // derive the dWallet's Sui address from its ED25519 public key.
  const pubBytes = await getDwalletEd25519PublicKeyForDwalletId(dwalletId);
  const dwalletSuiAddress = new Ed25519PublicKey(pubBytes).toSuiAddress();

  // preflight: the dWallet's Sui address has to pay gas on the SEND PTB itself (Sui's gas
  // resolver pulls gas from a SUI coin owned by the sender, which is the dWallet here -
  // separate from the ika sign PTB billed to the vault keypair). compute the dWallet's total
  // SUI balance and verify the send leaves at least DWALLET_SUI_GAS_RESERVE_MIST behind.
  let dwalletSuiTotal = 0n;
  {
    let cursor: string | null = null;
    for (;;) {
      const res = await s.suiClient.listCoins({
        owner: dwalletSuiAddress,
        coinType: NATIVE_SUI_COIN_TYPE,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      for (const o of res.objects) dwalletSuiTotal += BigInt(o.balance ?? '0');
      if (!res.hasNextPage) break;
      cursor = res.cursor;
    }
  }
  const isNativeSuiSend = normalizedType === NATIVE_SUI_COIN_TYPE || normalizedType === '0x2::sui::SUI';
  if (isNativeSuiSend) {
    if (dwalletSuiTotal < baseUnits + DWALLET_SUI_GAS_RESERVE_MIST) {
      throw new Error(
        `Need to leave ~${mistToSuiDisplay(DWALLET_SUI_GAS_RESERVE_MIST)} SUI at the dWallet's Sui address to pay Sui network gas on the send PTB. Balance: ${mistToSuiDisplay(dwalletSuiTotal)} SUI; attempted send: ${mistToSuiDisplay(baseUnits)} SUI. Lower the amount by at least ${mistToSuiDisplay(DWALLET_SUI_GAS_RESERVE_MIST)} SUI and retry.`,
      );
    }
  } else {
    // non-native (IKA / USDC / etc.): the dWallet still needs a SUI coin to pay gas.
    if (dwalletSuiTotal < DWALLET_SUI_GAS_RESERVE_MIST) {
      throw new Error(
        `Need at least ~${mistToSuiDisplay(DWALLET_SUI_GAS_RESERVE_MIST)} SUI at the dWallet's Sui address (${dwalletSuiAddress}) to pay network gas. Current SUI balance there: ${mistToSuiDisplay(dwalletSuiTotal)} SUI. Send a tiny amount of SUI to that address and retry.`,
      );
    }
  }

  const tx = new Transaction();
  tx.setSender(dwalletSuiAddress);

  const isNative = normalizedType === NATIVE_SUI_COIN_TYPE || normalizedType === '0x2::sui::SUI';

  if (isNative) {
    const [splitCoin] = tx.splitCoins(tx.gas, [baseUnits]);
    tx.transferObjects([splitCoin], dest);
  } else {
    // enumerate owned coin objects of this type at the dWallet's Sui address.
    const owned: { id: string; balance: bigint }[] = [];
    let cursor: string | null = null;
    for (;;) {
      const res = await s.suiClient.listCoins({
        owner: dwalletSuiAddress,
        coinType: normalizedType,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      for (const o of res.objects) {
        owned.push({ id: o.objectId, balance: BigInt(o.balance ?? '0') });
      }
      if (!res.hasNextPage) break;
      cursor = res.cursor;
    }
    if (!owned.length) {
      throw new Error(
        `No coins of type ${normalizedType} at dWallet Sui address ${dwalletSuiAddress}`,
      );
    }
    const sorted = owned
      .filter((c) => c.balance > 0n)
      .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
    const total = sorted.reduce((acc, c) => acc + c.balance, 0n);
    if (total < baseUnits) {
      throw new Error(
        `Insufficient balance at dWallet Sui address: have ${total.toString()} base units, need ${baseUnits.toString()}`,
      );
    }
    const primary = tx.object(sorted[0]!.id);
    let covered = sorted[0]!.balance;
    const mergeIds: string[] = [];
    for (let i = 1; i < sorted.length && covered < baseUnits; i++) {
      mergeIds.push(sorted[i]!.id);
      covered += sorted[i]!.balance;
    }
    if (mergeIds.length > 0) {
      tx.mergeCoins(primary, mergeIds.map((id) => tx.object(id)));
    }
    const [sendChunk] = tx.splitCoins(primary, [baseUnits]);
    tx.transferObjects([sendChunk], dest);
  }

  // build unsigned bytes for the dWallet sender. `tx.build` uses the sender we set above so
  // gas resolution picks a SUI coin at that address.
  const transactionBytes = await tx.build({ client: s.suiClient });

  // ---- DIAGNOSTIC LOGGING for "Invalid signature" debug ----
  // expose every step's input/output so we can pinpoint where verify breaks.
  const toHex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
  const intentMessageDiag = messageWithIntent('TransactionData', transactionBytes);
  const digestDiag = blake2b(intentMessageDiag, { dkLen: 32 });
  console.warn('[sui-send-from-dwallet] sign preflight', {
    dwalletId,
    dwalletSuiAddress,
    dwalletPubkeyHex: '0x' + toHex(pubBytes),
    sessionActiveEd25519MetaDwalletId: s.dwalletMeta.ED25519?.dwalletId,
    sessionMetaMatchesRequested: s.dwalletMeta.ED25519?.dwalletId === dwalletId,
    txBytesLen: transactionBytes.length,
    intentMessageLen: intentMessageDiag.length,
    blake2bDigestHex: '0x' + toHex(digestDiag),
    coinType: normalizedType,
    isNativeSuiSend,
  });
  // ----------------------------------------------------------

  // ika MPC ED25519 signs the intent message digest. retag deep ika errors so the user sees
  // which asset to fund instead of cryptic Move runtime / coin-picker text.
  let signature: string;
  try {
    const out = await signBuiltSuiTransactionBytes(transactionBytes, {
      ed25519DwalletId: dwalletId,
    });
    signature = out.signature;
    // ---- DIAGNOSTIC: run an independent ed25519.verify against the dWallet's pubkey ----
    try {
      // `out.signature` is Mysten-serialized (flag byte || sig || pubkey). pull the raw 64-byte
      // ed25519 sig out of it for our own check.
      const sigB64 = out.signature;
      // serialized format: base64 over [flag(1)=0x00 || ed25519_sig(64) || pubkey(32)] = 97 bytes
      const rawSerialized = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
      const sigOnly = rawSerialized.slice(1, 65);
      const pubOnly = rawSerialized.slice(65, 97);
      const verifyAgainstDigest = await ed25519.verify(sigOnly, digestDiag, pubOnly);
      console.warn('[sui-send-from-dwallet] sign result', {
        serializedSigLen: rawSerialized.length,
        signatureHex: '0x' + toHex(sigOnly),
        sigPubkeyHex: '0x' + toHex(pubOnly),
        pubkeyMatchesDwallet: toHex(pubOnly) === toHex(pubBytes),
        verifyAgainstBlakeDigest: verifyAgainstDigest,
      });
    } catch (diagErr) {
      console.warn('[sui-send-from-dwallet] diag verify threw', diagErr);
    }
    // ---------------------------------------------------------------------------------
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const vaultSuiAddr = s.suiKeypair.getPublicKey().toSuiAddress();
    // ---- DIAGNOSTIC: log every signBuiltSuiTransactionBytes throw so we can see the exact
    // error text + stack. without this, errors that don't match the retag conditions below
    // bubble up as `[sendUnified] <message>` with no breadcrumb at the wallet's own layer.
    console.warn('[sui-send-from-dwallet] signBuiltSuiTransactionBytes THREW', {
      errorMessage: msg,
      errorName: e instanceof Error ? e.name : 'unknown',
      errorStackPreview: e instanceof Error ? e.stack?.slice(0, 1200) : undefined,
      dwalletId,
      vaultSuiAddr,
    });
    // ----------------------------------------------------------
    if (msg.includes('Cannot pick SUI for ika splits') || msg.includes('Single SUI coin')) {
      throw new Error(
        `ika MPC sign failed: vault fee-payer Sui address (${vaultSuiAddr}) needs more SUI coin objects. Send a small amount of SUI to that address (or split an existing coin by sending part to yourself) and retry.`,
      );
    }
    if (msg.includes('Insufficient coin balance for operation') && msg.includes('replenish error')) {
      throw new Error(
        `Presign-pool refill failed: vault fee-payer (${vaultSuiAddr}) likely needs more IKA or SUI to cover the protocol-fee splits across the refill batch. Top up IKA (and a bit more SUI) at the vault address and retry. Original error: ${msg}`,
      );
    }
    if (msg.includes('No IKA for protocol fees')) {
      throw new Error(
        `Vault fee-payer Sui address (${vaultSuiAddr}) has no IKA coin objects. ika protocol fees are paid in IKA; acquire IKA at the vault address and retry.`,
      );
    }
    throw e;
  }

  // execute (also does a dry-run guard first).
  const result = await executeDappSuiSignedTransaction(tx, transactionBytes, signature);
  const digest = (result as { digest?: string }).digest ?? 'unknown';

  if (digest !== 'unknown') {
    try {
      const { recordSignedTx } = await import('@/background/services/tx-record');
      await recordSignedTx({
        txHash: digest,
        origin: null,
        chainId: 'sui-' + s.network,
        vaultId: s.activeVaultId,
        timestampMs: Date.now(),
        kind: 'sui-send',
      });
    } catch (e) {
      console.warn('[chromatika tx-record] sui-send (from dwallet) origin record failed', e);
    }
  }

  return digest;
}
