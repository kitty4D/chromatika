/**
 * SECP signing through the on-chain Policy Vault. replaces the direct
 * `coordinator.approve_message + request_sign` flow with the policy module's
 * `pop_presign + sign_with_policy` chained PTB, which gates the same MPC sign request
 * behind cap + cool-down + non-panicked + actuator checks.
 *
 * wire shape (mirrors `chains/signing/evm.ts:signBytesEvmCore` enough to be a drop-in
 * dispatch target):
 *   1. resolve session + verify policy link + verify not panicked.
 *   2. pop the next presign cap id from the local tracker. auto-replenish + resync if empty.
 *   3. fetch the cap's inner `presign_id` (via the cap object) and then the presign object
 *      itself (`getPresignInParticularState(..., 'Completed')`) so we have the bytes.
 *   4. decrypt the centralized user share via `UserShareEncryptionKeys.decryptUserShare`.
 *   5. compute `messageCentralizedSignature` via `createUserSignMessageWithPublicOutput`.
 *   6. build the policy PTB and execute via `executeSuiTransaction`.
 *   7. resolve sign session id from effects, poll for Completed, parse signature.
 *
 * returns `{ signature, signId }` where `signature` is the 64-byte r||s as 128-char hex.
 *
 * soft policy v0: `declaredValueMicros` is caller-supplied (chromatika resolves USD value
 * before calling). hard policy ships once the v1 Move RLP/SPL/PSBT decoders land:
 * `sign_evm_with_policy` (in `sign_gate_evm.move`) replaces the soft path.
 */

import {
  Curve,
  Hash,
  SignatureAlgorithm,
  createUserSignMessageWithPublicOutput,
  parseSignatureFromSignOutput,
  type ZeroTrustDWallet,
} from '@ika.xyz/sdk';

/**
 * map SECP256K1+ECDSA hash schemes to their Move u32 enum value. per ika docs:
 *   SECP256K1+ECDSA: 0=KECCAK256, 1=SHA256, 2=DoubleSHA256.
 * `fromHashToNumber` is not exported from @ika.xyz/sdk main entry (it's internal to
 * `hash-signature-validation.js`); the deep import path was flagged as fragile in CLAUDE.md.
 * hard-coding the mapping for the 3 SECP-ECDSA variants we use is more robust.
 */
type SecpEcdsaHash = typeof Hash.KECCAK256 | typeof Hash.SHA256 | typeof Hash.DoubleSHA256;
function secpEcdsaHashToNumber(h: SecpEcdsaHash): number {
  if (h === Hash.KECCAK256) return 0;
  if (h === Hash.SHA256) return 1;
  if (h === Hash.DoubleSHA256) return 2;
  throw new PolicyVaultSignError('execute-failed', `unsupported SECP+ECDSA hash: ${h}`);
}
import { Transaction } from '@mysten/sui/transactions';
import { getSession } from '@/background/session';
import { getIkaAdapter } from '@/background/ika/ika-adapter';
import { setSigningProgress } from '@/background/signing-progress';
import {
  assertActiveSecpDwallet,
  ensureEncryptedShareId,
  resolveSignSessionId,
  withTransientSuiReadRetry,
} from '@/background/chains/signing/internal';
import { graphqlUrlForNetwork } from '@/config/sui';
import { describePolicyVaultAbort } from '@/background/policy-vault/policy-vault-tx';
import { executeSuiTransaction } from '@/background/sui/execute-transaction';
import {
  getPolicyPackageConfig,
  getPolicyVaultLink,
} from '@/background/policy-vault/policy-vault-storage';
import {
  popPolicyPresignCapId,
  resyncPolicyPresignsFromChain,
} from '@/background/policy-vault/policy-vault-presigns';
import { appendPolicyAuditEntry } from '@/background/policy-vault/policy-vault-audit';
import {
  replenishPolicyPresign,
  panicPolicyVault as _unusedPanic,
} from '@/background/policy-vault/policy-vault-actions';
import { readPolicyVaultSnapshot } from '@/background/policy-vault/policy-vault-read';

void _unusedPanic;

const MODULE_NAME = 'sign_gate';

export class PolicyVaultSignError extends Error {
  constructor(
    readonly reason:
      | 'wallet-locked'
      | 'no-package'
      | 'no-link'
      | 'panicked'
      | 'cap-exceeded'
      | 'cool-down'
      | 'no-presigns'
      | 'execute-failed'
      | 'sign-mpc-failed',
    message: string,
  ) {
    super(`[policy-sign/${reason}] ${message}`);
    this.name = 'PolicyVaultSignError';
  }
}

export interface PolicySecpSignInput {
  /** raw bytes the dWallet should sign (chromatika hashes once via the requested scheme). */
  message: Uint8Array;
  /** hash scheme: KECCAK256 (EVM), SHA256 (generic), DoubleSHA256 (BTC + DeSo). */
  hashScheme: SecpEcdsaHash;
  /** best-effort declared value in micro-USD (1 USD = 1_000_000). 0 = no declared value. */
  declaredValueMicros: bigint;
  /**
   * EVM hard-policy mode: when set, chromatika dispatches through `sign_evm_with_policy`
   * (which decodes value + recipient on-chain via Move RLP parser) instead of the soft
   * `sign_with_policy`. ignored when `hashScheme !== KECCAK256`. pass current ETH/USD price
   * as micro-USD per ETH; chromatika resolves this via `getPrice('eth')`.
   *
   * **the chain-decoded value REPLACES `declaredValueMicros` for cap enforcement**. lying
   * about declared value is impossible on this path; lying about price is still possible
   * but every price is logged on-chain via the `EvmDecoded` event for audit.
   */
  evmHardPolicy?: {
    priceMicrosPerEth: bigint;
  };
  /**
   * BTC hard-policy mode: when set, chromatika dispatches through `sign_btc_with_policy`
   * (which decodes the BIP143 witness-v0 sighash preimage's `amount` field on-chain)
   * instead of soft `sign_with_policy`. ignored when `hashScheme !== DoubleSHA256`. pass
   * current BTC/USD price as micro-USD per satoshi; chromatika resolves this via
   * `getPrice('btc') / 1e8`.
   *
   * **the chain-decoded INPUT value (sats) REPLACES `declaredValueMicros` for cap
   * enforcement**. cap is on input (UTXO being spent), which is conservative: input >=
   * output (the diff is the fee). lying about declared value is impossible on this path;
   * price still soft, every value emitted on-chain via the `BtcDecoded` event for audit.
   */
  btcHardPolicy?: {
    priceMicrosPerSatoshi: bigint;
  };
  /**
   * DeSo hard-policy mode: when set, chromatika dispatches through `sign_deso_with_policy`
   * (which decodes the v0 DeSo binary tx's TxOutputs section on-chain and sums
   * AmountNanos) instead of soft `sign_with_policy`. ignored when `hashScheme !==
   * DoubleSHA256`. pass current DESO/USD price as micro-USD per DESO (e.g. $30/DESO ->
   * 30_000_000); chromatika resolves this via `getPrice('deso') * 1e6`.
   *
   * **the chain-decoded OUTPUT SUM (nanos) REPLACES `declaredValueMicros`**. cap is on
   * total outputs (= input - fee), conservative: includes any change going back to the
   * sender. trade-off is "safe and simple" vs "perfectly precise but compares pubkeys."
   * lying about declared value is impossible; price still soft, value emitted on-chain
   * via the `DeSoDecoded` event for audit. mutually exclusive with `btcHardPolicy`
   * (both use DoubleSHA256; caller picks one).
   */
  desoHardPolicy?: {
    priceMicrosPerDeso: bigint;
  };
}

/**
 * sign SECP256K1 ECDSA bytes through the active vault's PolicyVault. mirrors the return
 * shape of `signBytesEvm` so callers can swap in transparently.
 */
export async function signBytesSecpThroughPolicy(
  input: PolicySecpSignInput,
): Promise<{ signature: string; signId: string }> {
  const s = getSession();
  if (!s) {
    throw new PolicyVaultSignError('wallet-locked', 'unlock the wallet to sign through policy');
  }
  if (!s.activeVaultId) {
    throw new PolicyVaultSignError('wallet-locked', 'no active vault id in session');
  }

  const cfg = await getPolicyPackageConfig();
  if (!cfg) {
    throw new PolicyVaultSignError(
      'no-package',
      'chromatika_policy package id not configured. Set it in Settings -> Security.',
    );
  }
  // SECP256K1 signing path covers EVM / BTC / DeSo - all wrap the active vault's SECP dwallet.
  const dwalletId = s.dwalletMeta?.SECP256K1?.dwalletId;
  if (!dwalletId) {
    throw new PolicyVaultSignError(
      'no-link',
      'no SECP256K1 dWallet for the active vault.',
    );
  }
  const link = await getPolicyVaultLink(s.activeVaultId, dwalletId);
  if (!link) {
    throw new PolicyVaultSignError(
      'no-link',
      'no PolicyVault link for this SECP dWallet. Opt in first or use the direct sign path.',
    );
  }

  const adapter = getIkaAdapter(s, 'sui');

  // pre-flight on-chain read so we fail fast on panicked / no-presigns rather than burning
  // a sign tx that aborts.
  const snapshot = await readPolicyVaultSnapshot(s.suiClient, link.vaultObjectId);
  if (snapshot?.panicked) {
    void appendPolicyAuditEntry({
      vaultId: s.activeVaultId,
      dwalletId,
      kind: 'sign-aborted-panicked',
      detail: `declared=${input.declaredValueMicros.toString()}`,
    }).catch(() => {});
    throw new PolicyVaultSignError(
      'panicked',
      `vault is panicked. Unfreeze unlocks at ${new Date(snapshot.unfreezeUnlocksAtMs).toISOString()}.`,
    );
  }
  // pre-flight cap check so we don't burn a sign tx that the chain will abort.
  if (snapshot && snapshot.dailyCapMicros !== '0') {
    const capRemaining = BigInt(snapshot.dailyCapMicros) - BigInt(snapshot.spentTodayMicros);
    if (input.declaredValueMicros > capRemaining) {
      void appendPolicyAuditEntry({
        vaultId: s.activeVaultId,
        dwalletId,
        kind: 'sign-aborted-over-cap',
        detail: `declared=${input.declaredValueMicros.toString()} remaining=${capRemaining.toString()}`,
      }).catch(() => {});
      throw new PolicyVaultSignError(
        'cap-exceeded',
        `declared value (${input.declaredValueMicros.toString()} micro-USD) exceeds daily cap remaining (${capRemaining.toString()})`,
      );
    }
  }

  // get + auto-replenish if needed.
  let presignCapId = await popPolicyPresignCapId(s.activeVaultId, dwalletId);
  if (!presignCapId) {
    // re-sync from chain in case the local cache is stale (e.g. chromatika reinstall).
    setSigningProgress('taking-presign', 'resyncing presigns from chain');
    const onChainCount = await resyncPolicyPresignsFromChain(
      s.suiClient,
      s.activeVaultId,
      dwalletId,
      link.vaultObjectId,
    );
    if (onChainCount > 0) {
      presignCapId = await popPolicyPresignCapId(s.activeVaultId, dwalletId);
    }
  }
  if (!presignCapId) {
    setSigningProgress('taking-presign', 'replenishing policy presign');
    await replenishPolicyPresign(dwalletId);
    presignCapId = await popPolicyPresignCapId(s.activeVaultId, dwalletId);
  }
  if (!presignCapId) {
    throw new PolicyVaultSignError(
      'no-presigns',
      'could not seed a presign for the policy vault. Check IKA + SUI balance on the vault.',
    );
  }

  // fetch the cap object -> its inner presign_id -> the presign object itself.
  // the cap is `UnverifiedPresignCap` from `ika_dwallet_2pc_mpc::coordinator_inner`.
  const presignId = await readPresignIdFromCap(s.suiClient, presignCapId);
  if (!presignId) {
    throw new PolicyVaultSignError(
      'no-presigns',
      `could not read presign_id from cap ${presignCapId}. The vault's pool may be out of sync; try Settings -> Security -> "replenish presign" to refresh.`,
    );
  }
  const presign = await adapter.getPresignInParticularState(presignId, 'Completed', {
    timeout: 45_000,
  });

  // dWallet + encShare for user-side msgSig.
  const { dWallet } = await assertActiveSecpDwallet(s, adapter, link.dwalletId);
  const encShareId = await ensureEncryptedShareId(s, 'SECP256K1', adapter, link.dwalletId);
  const encShare = await adapter.getEncryptedUserSecretKeyShare(encShareId);
  const pp = await adapter.ikaClient.getProtocolPublicParameters(dWallet);
  const keys = s.ikaShareKeys.SECP256K1;
  if (!keys) {
    throw new PolicyVaultSignError('wallet-locked', 'no SECP256K1 share-encryption keys in session');
  }

  setSigningProgress('building-ika-tx', 'decrypting user share for policy sign');
  const { secretShare } = await keys.decryptUserShare(
    dWallet as ZeroTrustDWallet,
    encShare,
    pp,
  );
  const publicOutput = Uint8Array.from(
    (dWallet as ZeroTrustDWallet).state.Active!.public_output as unknown as number[],
  );
  const presignBytes = Uint8Array.from(
    (presign as { state: { Completed: { presign: number[] } } }).state.Completed.presign,
  );

  const msgSig = await createUserSignMessageWithPublicOutput(
    pp,
    publicOutput,
    secretShare,
    presignBytes,
    input.message,
    input.hashScheme,
    SignatureAlgorithm.ECDSASecp256k1,
    Curve.SECP256K1,
  );

  // build the policy PTB. four dispatch modes (in order of specificity):
  //   1. EVM hard mode (`sign_evm_with_policy`): RLP decoder + chain-derived value, when
  //      `evmHardPolicy` is set + hash is KECCAK256.
  //   2. BTC hard mode (`sign_btc_with_policy`): BIP143 witness-v0 amount decoder +
  //      chain-derived value (input UTXO sats), when `btcHardPolicy` is set + hash is
  //      DoubleSHA256.
  //   3. DeSo hard mode (`sign_deso_with_policy`): v0 binary TxOutputs decoder + chain-
  //      derived value (sum of AmountNanos), when `desoHardPolicy` is set + hash is
  //      DoubleSHA256. BTC and DeSo are mutually exclusive (caller picks one).
  //   4. soft (`sign_with_policy`): caller-declared value. used for generic SHA256, or
  //      any path that opts out of hard mode.
  const useEvmHardMode =
    input.evmHardPolicy != null && input.hashScheme === Hash.KECCAK256;
  const useBtcHardMode =
    !useEvmHardMode &&
    input.btcHardPolicy != null &&
    input.hashScheme === Hash.DoubleSHA256;
  const useDeSoHardMode =
    !useEvmHardMode &&
    !useBtcHardMode &&
    input.desoHardPolicy != null &&
    input.hashScheme === Hash.DoubleSHA256;
  const tx = new Transaction();
  const vaultArg = tx.object(link.vaultObjectId);
  const coordArg = tx.object(adapter.ikaClient.ikaConfig.objects.ikaDWalletCoordinator.objectID);
  const popped = tx.moveCall({
    target: `${cfg.packageId}::${MODULE_NAME}::pop_presign`,
    arguments: [vaultArg],
  });
  if (useEvmHardMode) {
    tx.moveCall({
      target: `${cfg.packageId}::sign_gate_evm::sign_evm_with_policy`,
      arguments: [
        vaultArg,
        coordArg,
        popped,
        tx.pure.vector('u8', Array.from(input.message)),
        tx.pure.u64(input.evmHardPolicy!.priceMicrosPerEth),
        tx.pure.u32(secpEcdsaHashToNumber(input.hashScheme)),
        tx.pure.vector('u8', Array.from(msgSig)),
        tx.object('0x6'),
      ],
    });
  } else if (useBtcHardMode) {
    tx.moveCall({
      target: `${cfg.packageId}::sign_gate_btc::sign_btc_with_policy`,
      arguments: [
        vaultArg,
        coordArg,
        popped,
        tx.pure.vector('u8', Array.from(input.message)),
        tx.pure.u64(input.btcHardPolicy!.priceMicrosPerSatoshi),
        tx.pure.u32(secpEcdsaHashToNumber(input.hashScheme)),
        tx.pure.vector('u8', Array.from(msgSig)),
        tx.object('0x6'),
      ],
    });
  } else if (useDeSoHardMode) {
    tx.moveCall({
      target: `${cfg.packageId}::sign_gate_deso::sign_deso_with_policy`,
      arguments: [
        vaultArg,
        coordArg,
        popped,
        tx.pure.vector('u8', Array.from(input.message)),
        tx.pure.u64(input.desoHardPolicy!.priceMicrosPerDeso),
        tx.pure.u32(secpEcdsaHashToNumber(input.hashScheme)),
        tx.pure.vector('u8', Array.from(msgSig)),
        tx.object('0x6'),
      ],
    });
  } else {
    tx.moveCall({
      target: `${cfg.packageId}::${MODULE_NAME}::sign_with_policy`,
      arguments: [
        vaultArg,
        coordArg,
        popped,
        tx.pure.vector('u8', Array.from(input.message)),
        tx.pure.u64(input.declaredValueMicros),
        tx.pure.u32(secpEcdsaHashToNumber(input.hashScheme)),
        tx.pure.vector('u8', Array.from(msgSig)),
        tx.object('0x6'),
      ],
    });
  }

  setSigningProgress('executing-ika-tx', 'sign_with_policy PTB');
  const result = await executeSuiTransaction(s, tx, { include: { effects: true, events: true } });
  if (result.$kind === 'FailedTransaction') {
    const errRaw = result.FailedTransaction.status.error;
    const msg = typeof errRaw === 'string' ? errRaw : JSON.stringify(errRaw);
    const friendly = describePolicyVaultAbort(msg) ?? msg;
    // audit the chain-side abort. pre-flight already covers most cases, but cool-down +
    // race conditions land here.
    let abortKind: 'sign-aborted-over-cap' | 'sign-aborted-panicked' | 'sign-aborted-cool-down' | null = null;
    if (friendly.includes('cool-down')) abortKind = 'sign-aborted-cool-down';
    else if (friendly.includes('panicked')) abortKind = 'sign-aborted-panicked';
    else if (friendly.includes('cap')) abortKind = 'sign-aborted-over-cap';
    if (abortKind) {
      void appendPolicyAuditEntry({
        vaultId: s.activeVaultId,
        dwalletId,
        kind: abortKind,
        detail: friendly.slice(0, 200),
      }).catch(() => {});
    }
    if (friendly.includes('cap')) throw new PolicyVaultSignError('cap-exceeded', friendly);
    if (friendly.includes('cool-down')) throw new PolicyVaultSignError('cool-down', friendly);
    if (friendly.includes('panicked')) throw new PolicyVaultSignError('panicked', friendly);
    throw new PolicyVaultSignError('execute-failed', friendly);
  }
  const T = (result as { Transaction?: { effects?: unknown; events?: unknown } }).Transaction;
  if (!T) {
    throw new PolicyVaultSignError('execute-failed', 'sign_with_policy effects missing');
  }
  const signId = await resolveSignSessionId(
    adapter,
    Curve.SECP256K1,
    SignatureAlgorithm.ECDSASecp256k1,
    T.effects as never,
    T.events as never,
  );
  if (!signId) {
    throw new PolicyVaultSignError(
      'execute-failed',
      'sign_with_policy executed but could not resolve Sign session id from effects',
    );
  }

  setSigningProgress('waiting-signature', signId);
  const gqlUrl = graphqlUrlForNetwork(s.network);
  const sign = await withTransientSuiReadRetry(
    () =>
      adapter.getSignInParticularState(
        signId,
        Curve.SECP256K1,
        SignatureAlgorithm.ECDSASecp256k1,
        'Completed',
        { timeout: 120_000 },
      ),
    { log: { graphqlUrl: gqlUrl, label: 'getSignInParticularState policy-vault sign' } },
  );
  if (sign.state.$kind !== 'Completed') {
    throw new PolicyVaultSignError(
      'sign-mpc-failed',
      `Sign session not completed: ${sign.state.$kind}`,
    );
  }
  const raw = Uint8Array.from(sign.state.Completed.signature as unknown as number[]);
  const parsed =
    raw.length === 64
      ? raw
      : await parseSignatureFromSignOutput(
          Curve.SECP256K1,
          SignatureAlgorithm.ECDSASecp256k1,
          raw,
        );
  if (parsed.length !== 64) {
    throw new PolicyVaultSignError(
      'sign-mpc-failed',
      `parsed signature is not 64 bytes (got ${parsed.length})`,
    );
  }
  let signatureHex = '';
  for (const b of parsed) signatureHex += b.toString(16).padStart(2, '0');
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'sign-cap-applied',
    digest: signId,
    next: input.declaredValueMicros.toString(),
    detail: `hash=${input.hashScheme}`,
  }).catch(() => {});
  return { signature: signatureHex, signId };
}

/**
 * read the inner `presign_id: ID` field from a `coordinator_inner::UnverifiedPresignCap` Sui
 * object. defensive across plausible Mysten parsed-content shapes.
 */
async function readPresignIdFromCap(
  client: import('@mysten/sui/graphql').SuiGraphQLClient,
  capObjectId: string,
): Promise<string | null> {
  type RespShape = {
    objects?: Array<{
      content?: { fields?: Record<string, unknown> } | Record<string, unknown>;
    }>;
  };
  let response: RespShape | null = null;
  try {
    const raw = await (client.core as unknown as {
      getObjects: (opts: { objectIds: string[] }) => Promise<unknown>;
    }).getObjects({ objectIds: [capObjectId] });
    response = raw as RespShape;
  } catch (e) {
    console.warn('[chromatika policy-sign] readPresignIdFromCap failed:', e);
    return null;
  }
  const obj = response?.objects?.[0];
  if (!obj?.content) return null;
  const root = obj.content as { fields?: Record<string, unknown> } & Record<string, unknown>;
  const fields = (root.fields && typeof root.fields === 'object' ? root.fields : root) as Record<
    string,
    unknown
  >;
  const id = fields.presign_id;
  if (typeof id === 'string' && /^0x[0-9a-fA-F]{64}$/.test(id)) return id;
  if (id && typeof id === 'object') {
    const inner = (id as { id?: unknown }).id;
    if (typeof inner === 'string' && /^0x[0-9a-fA-F]{64}$/.test(inner)) return inner;
  }
  return null;
}

/**
 * should chromatika dispatch through the policy vault for this sign? pure check; reads
 * storage only. callers use this to decide between `signBytesSecpThroughPolicy` and the
 * legacy direct `signBytesEvm` etc. paths.
 */
export async function shouldDispatchThroughPolicy(
  curve: 'SECP256K1' | 'ED25519' = 'SECP256K1',
): Promise<boolean> {
  const s = getSession();
  if (!s?.activeVaultId) return false;
  const cfg = await getPolicyPackageConfig();
  if (!cfg) return false;
  const dwalletId = s.dwalletMeta?.[curve]?.dwalletId;
  if (!dwalletId) return false;
  const link = await getPolicyVaultLink(s.activeVaultId, dwalletId);
  return link != null;
}
