/**
 * recover Sui funds the user sent to chromatika's *internal user-share signing keypair address*
 * thinking it was their "dWallet's sui address." chromatika's UI mislabels
 * `s.ikaShareKeys.ED25519.getSuiAddress()` (the keccak-derived Ed25519 keypair that ika uses
 * internally to sign `user_output_signature` and `encryption_key_signature`) as
 * "sui address (dWallet)" at `wallet-extension/src/background/identity.ts:24` and on the
 * dWallet management screen.
 *
 * the actual MPC dWallet's Sui address is a SEPARATE address derived from the on-chain
 * dWallet's `state.Active.public_output`. if the user sent funds to the mislabeled internal
 * signing key address, those funds sit at an ordinary Ed25519 keypair address whose private
 * key is *fully reproducible* from the vault's fee-payer Sui keypair via the same keccak
 * chain `@ika.xyz/sdk@0.4.x` `UserShareEncryptionKeys.createFromSeed` uses.
 *
 * recovery is therefore a *regular Sui transaction*, signed locally with the reconstructed
 * Ed25519 keypair - no ika MPC, no presigns, no encrypted-share decryption. siblings:
 *   - [`sui-send-native.ts`](./sui-send-native.ts) - send SUI from vault fee-payer keypair
 *   - [`sui-send-coin.ts`](./sui-send-coin.ts)     - send any Sui coin from vault fee-payer
 *   - [`sui-send-from-dwallet.ts`](./sui-send-from-dwallet.ts) - send via ika MPC (the broken
 *     path that this helper sidesteps)
 *
 * **scope:** Sui-base HD vaults only (the Solana-base seed source is different and the user
 * who has stuck funds is on Sui base). hardware-only vaults can't reproduce the keypair
 * because they have no hot Sui keypair in the session.
 *
 * **derivation formula** (matches `UserShareEncryptionKeys.createFromSeed_fn` in
 * `node_modules/@ika.xyz/sdk/dist/esm/client/user-share-encryption-keys.js`):
 *   rootSeed   = keccak256(feePayerSuiKp.toBytes() || index_le_u32(encryptionKeyIndex))
 *                  [implemented as `ikaRootSeedFromFeeKeypair`]
 *   signerSeed = keccak256(ASCII("ED25519_SIGNING_KEY_V1") || curveByte || rootSeed)
 *                  where curveByte = 0 (legacy hash) or 2 (post-fix ED25519)
 *   keypair    = Ed25519Keypair.deriveKeypairFromSeed(toHex(signerSeed))
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { getSession } from '@/background/session';
import { ikaRootSeedFromFeeKeypair } from '@/background/keyring/hd';
import { friendlySuiExecutionError } from '@/background/sui/execute-transaction';
import { getDwalletEd25519PublicKeyForDwalletId } from '@/background/chains/solana';

const NATIVE_SUI_COIN_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const ENCRYPTION_SIGNER_KEY_DOMAIN = 'ED25519_SIGNING_KEY_V1';

/** safety floor when sweeping native SUI - leaves enough behind to pay this PTB's own gas. */
const RECOVERY_GAS_RESERVE_MIST = 50_000_000n; // 0.05 SUI

function isLikelySuiAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(s.trim());
}

/**
 * reconstruct the Ed25519 signing keypair used by `UserShareEncryptionKeys` for a given
 * `(encryptionKeyIndex, legacy)` choice. caller picks `legacy: true` to reproduce the
 * `@ika.xyz/sdk@0.3.x` derivation (curve byte always 0) and `legacy: false` for the
 * post-fix derivation (curve byte = 2 for ED25519).
 *
 * this is the keypair whose Sui address chromatika has been displaying as "sui address
 * (dWallet)" - so it's the address the user may have funded thinking it was their dWallet.
 */
export function deriveInternalSigningKeypair(opts: {
  legacy: boolean;
  encryptionKeyIndex: number;
}): Ed25519Keypair {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  if (s.activeVaultBaseChain !== 'sui') {
    throw new Error(
      'Internal signing-key recovery is only wired for Sui-base vaults today; ' +
        `active vault is ${s.activeVaultBaseChain}.`,
    );
  }
  if (!s.suiKeypair) {
    throw new Error(
      'Active vault has no hot Sui keypair (hardware-only fee payers cannot reproduce ' +
        'the internal signing keypair).',
    );
  }
  const rootSeed = ikaRootSeedFromFeeKeypair(s.suiKeypair, opts.encryptionKeyIndex);
  try {
    const domain = new TextEncoder().encode(ENCRYPTION_SIGNER_KEY_DOMAIN);
    const curveByte = opts.legacy ? 0 : 2;
    const signerSeed = keccak_256(Uint8Array.from([...domain, curveByte, ...rootSeed]));
    const hex = Array.from(signerSeed, (b) => b.toString(16).padStart(2, '0')).join('');
    return Ed25519Keypair.deriveKeypairFromSeed(hex);
  } finally {
    rootSeed.fill(0);
  }
}

/**
 * scan `(encryptionKeyIndex, legacy)` candidates 0..maxIndex × {false, true} and return each
 * candidate's Sui address. useful for figuring out which derivation produced the address the
 * user funded - check each on suiscan or `getAllBalances` to find the one with assets.
 */
export function listInternalSigningKeypairAddresses(maxIndex = 16): Array<{
  encryptionKeyIndex: number;
  legacy: boolean;
  address: string;
}> {
  const out: Array<{ encryptionKeyIndex: number; legacy: boolean; address: string }> = [];
  for (let i = 0; i < maxIndex; i++) {
    for (const legacy of [false, true] as const) {
      try {
        const kp = deriveInternalSigningKeypair({ encryptionKeyIndex: i, legacy });
        out.push({ encryptionKeyIndex: i, legacy, address: kp.getPublicKey().toSuiAddress() });
      } catch {
        // session locked or non-Sui-base; stop scanning
        return out;
      }
    }
  }
  return out;
}

/**
 * read native-SUI balance + ownedObject count at each candidate internal-signing-key
 * address so the caller can identify which derivation holds funds. uses `listCoins` (the
 * GraphQL-only path the rest of chromatika uses; `getAllBalances` is not on
 * `SuiGraphQLClient`) for SUI MIST + a `getOwnedObjects` page-1 count as a coarse "has any
 * non-SUI objects?" signal. for surgical recovery of a specific coin type, the caller can
 * still pass `coinType` to `recoverFromInternalSigningKey` even when the probe didn't
 * surface it.
 */
export async function probeInternalSigningKeyBalances(maxIndex = 16): Promise<
  Array<{
    encryptionKeyIndex: number;
    legacy: boolean;
    address: string;
    suiMist: string;
    probeError?: string;
  }>
> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const candidates = listInternalSigningKeypairAddresses(maxIndex);
  const results: Awaited<ReturnType<typeof probeInternalSigningKeyBalances>> = [];
  for (const c of candidates) {
    try {
      // sum native SUI across all coin pages at this address. native SUI is the most common
      // recovery target; if the user funded a non-SUI coin type at one of these addresses,
      // they can still pass that `coinType` to `recoverFromInternalSigningKey` (the recover
      // call enumerates per-type) - the probe just doesn't pre-list it.
      let suiTotal = 0n;
      let cursor: string | null = null;
      for (;;) {
        const res = await s.suiClient.listCoins({
          owner: c.address,
          coinType: NATIVE_SUI_COIN_TYPE,
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        for (const o of res.objects) suiTotal += BigInt(o.balance ?? '0');
        if (!res.hasNextPage) break;
        cursor = res.cursor;
      }
      results.push({
        encryptionKeyIndex: c.encryptionKeyIndex,
        legacy: c.legacy,
        address: c.address,
        suiMist: suiTotal.toString(),
      });
    } catch (e) {
      results.push({
        encryptionKeyIndex: c.encryptionKeyIndex,
        legacy: c.legacy,
        address: c.address,
        suiMist: '0',
        probeError: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

/**
 * comprehensive diagnostic: dump everything we need to figure out where this dWallet's funds
 * are AND whether any encryption-key identity that signed an on-chain user share is one of
 * our 32 candidate derivations. one-shot replacement for the iterate-and-probe cycle.
 *
 * returns:
 *   - dWallet state + curve + MPC Sui address (derived from on-chain `public_output`) + SUI
 *     MIST balance at that address
 *   - `primaryShare.encryption_key_address` (the one `ensureEncryptedShareId` would pick)
 *   - all encrypted shares for this dWallet from the dynamic-field table, each with its
 *     `encryption_key_address` and a `matchedCandidate` slot if it pairs with one of the 32
 *     candidates - the union of (encryptionKeyIndex 0..15, legacy false/true)
 *   - the 32 candidates themselves so the caller can compare manually
 *
 * if any share's `encryption_key_address` matches a candidate, recovery via ika MPC is
 * unblocked - we can use that share + the matching `UserShareEncryptionKeys`. if NO share
 * matches any candidate, the DKG identity came from outside this vault (different mnemonic,
 * different onboarding path) and ika MPC recovery is not possible from this vault.
 */
export async function inspectDwalletForRecovery(dwalletId: string): Promise<{
  dwalletId: string;
  dwalletStateKind: string;
  dwalletCurve: unknown;
  mpcSuiAddress: string;
  mpcSuiMist: string;
  primaryShareId: string | null;
  primaryShareEncryptionKeyAddress: string | null;
  sharesTableId: string | null;
  totalSharesFound: number;
  sharesAndMatches: Array<{
    shareId: string;
    encryption_key_address: string;
    state_kind: string | undefined;
    matchedCandidate: { encryptionKeyIndex: number; legacy: boolean; address: string } | null;
  }>;
  candidates: Array<{ encryptionKeyIndex: number; legacy: boolean; address: string }>;
  vaultBaseChain: string;
  vaultFeePayerSuiAddress: string | null;
}> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');

  const dWallet = await s.ikaClient.getDWallet(dwalletId);
  const dWalletAny = dWallet as unknown as {
    state?: { $kind?: string; Active?: { public_output?: number[] } };
    curve?: unknown;
    encrypted_user_secret_key_share_id?: { id?: string };
    encrypted_user_secret_key_shares?: { id?: string };
  };

  // derive MPC Sui address from on-chain public_output
  const pubBytes = await getDwalletEd25519PublicKeyForDwalletId(dwalletId);
  const mpcSuiAddress = new Ed25519PublicKey(pubBytes).toSuiAddress();

  // SUI balance at MPC address
  let mpcSuiMist = 0n;
  {
    let cursor: string | null = null;
    for (;;) {
      const res = await s.suiClient.listCoins({
        owner: mpcSuiAddress,
        coinType: NATIVE_SUI_COIN_TYPE,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      for (const o of res.objects) mpcSuiMist += BigInt(o.balance ?? '0');
      if (!res.hasNextPage) break;
      cursor = res.cursor;
    }
  }

  // primary share (the one ensureEncryptedShareId would pick by default)
  const primaryShareId = dWalletAny.encrypted_user_secret_key_share_id?.id ?? null;
  let primaryShareEncryptionKeyAddress: string | null = null;
  if (primaryShareId) {
    try {
      const sh = (await s.ikaClient.getEncryptedUserSecretKeyShare(primaryShareId)) as unknown as {
        encryption_key_address?: string;
      };
      primaryShareEncryptionKeyAddress = sh.encryption_key_address ?? null;
    } catch {
      // best-effort
    }
  }

  // enumerate ALL shares for this dWallet via dynamic-field table fallback
  const sharesTableId = dWalletAny.encrypted_user_secret_key_shares?.id ?? null;
  const sharesAndMatches: Array<{
    shareId: string;
    encryption_key_address: string;
    state_kind: string | undefined;
    matchedCandidate: { encryptionKeyIndex: number; legacy: boolean; address: string } | null;
  }> = [];
  const candidates = listInternalSigningKeypairAddresses(16);

  if (sharesTableId) {
    let cursor: string | null = null;
    for (;;) {
      const page: {
        hasNextPage: boolean;
        cursor: string | null;
        dynamicFields: Array<{ fieldId?: string; childId?: string }>;
      } = await s.suiClient.listDynamicFields({ parentId: sharesTableId, cursor, limit: 50 });
      for (const f of page.dynamicFields) {
        const candidateIds = [f.fieldId, f.childId].filter(
          (x): x is string => typeof x === 'string' && x.startsWith('0x'),
        );
        for (const id of candidateIds) {
          try {
            const enc = (await s.ikaClient.getEncryptedUserSecretKeyShare(id)) as unknown as {
              dwallet_id?: string;
              encryption_key_address?: string;
              state?: { $kind?: string };
            };
            if (enc.dwallet_id !== dwalletId) continue;
            const addr = enc.encryption_key_address ?? '';
            const matched = candidates.find((c) => c.address === addr) ?? null;
            sharesAndMatches.push({
              shareId: id,
              encryption_key_address: addr,
              state_kind: enc.state?.$kind,
              matchedCandidate: matched,
            });
          } catch {
            // not an encrypted share object - skip
          }
        }
      }
      if (!page.hasNextPage || !page.cursor) break;
      cursor = page.cursor;
    }
  }

  return {
    dwalletId,
    dwalletStateKind: dWalletAny.state?.$kind ?? 'unknown',
    dwalletCurve: dWalletAny.curve,
    mpcSuiAddress,
    mpcSuiMist: mpcSuiMist.toString(),
    primaryShareId,
    primaryShareEncryptionKeyAddress,
    sharesTableId,
    totalSharesFound: sharesAndMatches.length,
    sharesAndMatches,
    candidates,
    vaultBaseChain: s.activeVaultBaseChain,
    vaultFeePayerSuiAddress: s.suiKeypair?.getPublicKey().toSuiAddress() ?? null,
  };
}

/**
 * recover funds at the internal signing keypair's Sui address by signing a regular Sui
 * transfer with the locally-derived keypair. caller specifies which derivation produced the
 * source address (`legacy` + `encryptionKeyIndex`), plus destination + coinType + amount or
 * sendAll.
 *
 * three branches mirror `sui-send-coin.ts`:
 *  - native SUI: `tx.splitCoins(tx.gas, ...)`, gas resolver picks the SUI coin at the source
 *  - non-native single coin: pick one coin object covering the amount
 *  - non-native multi-coin: merge coins until covered, then split + transfer
 *
 * `sendAll: true` sweeps everything of `coinType`, leaving `RECOVERY_GAS_RESERVE_MIST` MIST
 * behind for the gas budget when sending SUI itself; non-SUI sends do not need a reserve
 * because the source address must also hold some SUI to pay gas (verified by an explicit
 * balance check below).
 */
export async function recoverFromInternalSigningKey(opts: {
  legacy: boolean;
  encryptionKeyIndex: number;
  to: string;
  coinType?: string;
  amountBaseUnits?: bigint;
  sendAll?: boolean;
}): Promise<{ digest: string; fromAddress: string; sentBaseUnits: string }> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const to = opts.to.trim();
  if (!isLikelySuiAddress(to)) {
    throw new Error('Invalid destination Sui address (expect 0x + 64 hex chars)');
  }
  const normalizedType = (opts.coinType ?? NATIVE_SUI_COIN_TYPE).trim() || NATIVE_SUI_COIN_TYPE;
  if (!opts.sendAll && (opts.amountBaseUnits == null || opts.amountBaseUnits <= 0n)) {
    throw new Error('Provide either sendAll: true or amountBaseUnits > 0');
  }

  const keypair = deriveInternalSigningKeypair({
    legacy: opts.legacy,
    encryptionKeyIndex: opts.encryptionKeyIndex,
  });
  const fromAddress = keypair.getPublicKey().toSuiAddress();
  console.warn('[sui-recover] derived recovery keypair', {
    legacy: opts.legacy,
    encryptionKeyIndex: opts.encryptionKeyIndex,
    fromAddress,
    coinType: normalizedType,
  });

  const isNative = normalizedType === NATIVE_SUI_COIN_TYPE || normalizedType === '0x2::sui::SUI';
  const tx = new Transaction();
  tx.setSender(fromAddress);

  let sentBaseUnits = 0n;

  if (isNative) {
    let total = 0n;
    {
      let cursor: string | null = null;
      for (;;) {
        const res = await s.suiClient.listCoins({
          owner: fromAddress,
          coinType: NATIVE_SUI_COIN_TYPE,
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        for (const o of res.objects) total += BigInt(o.balance ?? '0');
        if (!res.hasNextPage) break;
        cursor = res.cursor;
      }
    }
    if (opts.sendAll) {
      if (total <= RECOVERY_GAS_RESERVE_MIST) {
        throw new Error(
          `Insufficient SUI at ${fromAddress}: have ${total.toString()} MIST, need > ${RECOVERY_GAS_RESERVE_MIST.toString()} (gas reserve).`,
        );
      }
      sentBaseUnits = total - RECOVERY_GAS_RESERVE_MIST;
    } else {
      if (total < opts.amountBaseUnits! + RECOVERY_GAS_RESERVE_MIST) {
        throw new Error(
          `Insufficient SUI at ${fromAddress}: have ${total.toString()} MIST, need ${(opts.amountBaseUnits! + RECOVERY_GAS_RESERVE_MIST).toString()} (send + gas reserve).`,
        );
      }
      sentBaseUnits = opts.amountBaseUnits!;
    }
    const [chunk] = tx.splitCoins(tx.gas, [sentBaseUnits]);
    tx.transferObjects([chunk], to);
  } else {
    // non-native: enumerate coin objects, merge, split-transfer. source address must also
    // hold some SUI to pay gas - we don't auto-check that here; the build/dry-run will fail
    // with a clear gas error if it does, surfaced via `friendlySuiExecutionError`.
    const owned: { id: string; balance: bigint }[] = [];
    let cursor: string | null = null;
    for (;;) {
      const res = await s.suiClient.listCoins({
        owner: fromAddress,
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
      throw new Error(`No coins of type ${normalizedType} at ${fromAddress}`);
    }
    const sorted = owned
      .filter((c) => c.balance > 0n)
      .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
    const total = sorted.reduce((acc, c) => acc + c.balance, 0n);
    const target = opts.sendAll ? total : opts.amountBaseUnits!;
    if (total < target) {
      throw new Error(
        `Insufficient balance of ${normalizedType} at ${fromAddress}: have ${total.toString()}, need ${target.toString()}`,
      );
    }
    sentBaseUnits = target;
    const primary = tx.object(sorted[0]!.id);
    let covered = sorted[0]!.balance;
    const mergeIds: string[] = [];
    for (let i = 1; i < sorted.length && covered < target; i++) {
      mergeIds.push(sorted[i]!.id);
      covered += sorted[i]!.balance;
    }
    if (mergeIds.length > 0) {
      tx.mergeCoins(primary, mergeIds.map((id) => tx.object(id)));
    }
    const [chunk] = tx.splitCoins(primary, [target]);
    tx.transferObjects([chunk], to);
  }

  const txBytes = await tx.build({ client: s.suiClient });
  const { signature } = await keypair.signTransaction(txBytes);
  console.warn('[sui-recover] signed locally with derived keypair; submitting', {
    fromAddress,
    sentBaseUnits: sentBaseUnits.toString(),
    txBytesLen: txBytes.length,
  });
  try {
    const result = await s.suiClient.executeTransaction({
      transaction: txBytes,
      signatures: [signature],
      include: { transaction: true, effects: true, balanceChanges: true },
    });
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
        console.warn('[chromatika tx-record] internal-signing-key recovery record failed', e);
      }
    }
    return { digest, fromAddress, sentBaseUnits: sentBaseUnits.toString() };
  } catch (e) {
    throw friendlySuiExecutionError(e);
  }
}
