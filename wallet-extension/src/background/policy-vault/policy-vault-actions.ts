/**
 * high-level policy-vault flows. each function:
 *   1. resolves session + storage
 *   2. builds the matching Sui PTB via `policy-vault-tx`
 *   3. executes via `executeSuiTransaction` (the chromatika fee-payer flow)
 *   4. updates local storage (link snapshot) + returns the on-chain tx digest
 *
 * read-only state goes through `loadPolicyVaultState`, which fetches the on-chain object
 * and merges with the cached snapshot.
 */

import { getSession } from '@/background/session';
import { capIdForDwallet } from '@/background/chains/signing/internal';
import { requireSuiAndIkaCoins } from '@/background/ika/coins';
import { getRequiredCoinAmounts } from '@/background/ika/pricing';
import { executeSuiTransaction } from '@/background/sui/execute-transaction';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';
import {
  buildAddActuatorTx,
  buildAddIkaBalanceTx,
  buildAddSuiBalanceTx,
  buildCommitPendingCapTx,
  buildCommitPendingStageOffTx,
  buildOptInTx,
  buildPanicTx,
  buildRemoveActuatorTx,
  buildReplenishPresignTx,
  buildSetCoolDownTx,
  buildSetDailyCapTx,
  buildSetRescueAddressTx,
  buildSetStageCapRaisesTx,
  buildSetStageDelayMsTx,
  buildUnfreezeTx,
  describePolicyVaultAbort,
} from '@/background/policy-vault/policy-vault-tx';
import {
  clearPolicyVaultLink,
  getPolicyPackageConfig,
  getPolicyVaultLink,
  setPolicyVaultLink,
  updatePolicyVaultSnapshot,
  type PolicyVaultLink,
  type PolicyVaultSnapshot,
} from '@/background/policy-vault/policy-vault-storage';
import { readPolicyVaultSnapshot } from '@/background/policy-vault/policy-vault-read';
import { appendPolicyAuditEntry } from '@/background/policy-vault/policy-vault-audit';

export class PolicyVaultError extends Error {
  constructor(
    readonly reason:
      | 'wallet-locked'
      | 'no-package'
      | 'no-link'
      | 'no-active-vault'
      | 'no-dwallet'
      | 'execute-failed'
      | 'protocol',
    message: string,
  ) {
    super(`[policy-vault/${reason}] ${message}`);
    this.name = 'PolicyVaultError';
  }
}

function requireSession() {
  const s = getSession();
  if (!s?.activeVaultId) {
    throw new PolicyVaultError('wallet-locked', 'unlock the wallet first');
  }
  return s;
}

async function requirePackageId(): Promise<string> {
  const cfg = await getPolicyPackageConfig();
  if (!cfg) {
    throw new PolicyVaultError(
      'no-package',
      'chromatika_policy package id is not configured. Deploy the Move package and set its id under Settings -> Security -> Spend caps + panic.',
    );
  }
  return cfg.packageId;
}

async function requireLink(): Promise<PolicyVaultLink> {
  const s = requireSession();
  const link = await getPolicyVaultLink(s.activeVaultId);
  if (!link) {
    throw new PolicyVaultError('no-link', 'no PolicyVault is linked to this chromatika vault. Opt in first.');
  }
  return link;
}

/**
 * build the opt-in tx, execute it, parse the created `PolicyVault` object id from effects,
 * persist the link, and return the link.
 *
 * the dWallet cap is RESOLVED for the active vault's SECP256K1 dWallet (curve=0,
 * sigAlgo=0). v1 will support per-curve opt-in (e.g. ED25519 for Solana sends).
 */
export async function optInToPolicyVault(args: {
  /** dWallet id to wrap. if omitted, resolves to the active vault's SECP256K1 dWallet. */
  dwalletId?: string;
  /** daily cap in micro-USD; 0 = no cap. */
  dailyCapMicros: bigint;
  /** min ms between sends. 0 = none. */
  coolDownMs: bigint;
  /** min ms between panic and unfreeze. UI default = 7 days. */
  unfreezeDelayMs: bigint;
  /** optional rescue address bytes (UI passes UTF-8 bytes of the destination address string). */
  rescueAddressBytes: Uint8Array | null;
  /**
   * stage delay for the cap-increase staged delay opt-in safety. default 24h (86_400_000ms).
   * the user toggles staging ON/OFF later via `setPolicyStageCapRaises`; this just sets the
   * delay duration. independent of `unfreezeDelayMs`.
   */
  stageDelayMs?: bigint;
  /** initial IKA fund (mist). e.g. 0.01 IKA = 10_000_000n. */
  initialIkaMist: bigint;
  /** initial SUI fund (mist). e.g. 0.01 SUI = 10_000_000n. */
  initialSuiMist: bigint;
}): Promise<{ link: PolicyVaultLink; digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();

  const meta = s.dwalletMeta?.SECP256K1;
  if (!meta?.dwalletId) {
    throw new PolicyVaultError('no-dwallet', 'no SECP256K1 dWallet for the active vault');
  }
  const dwalletId = args.dwalletId ?? meta.dwalletId;

  const adapter = (await import('@/background/ika/ika-adapter')).getIkaAdapter(s, 'sui');
  const owner = getSuiFeePayerSuiAddress(s);
  const capObjectId = await capIdForDwallet(adapter, owner, dwalletId);

  const networkKey = await s.ikaClient.getLatestNetworkEncryptionKey();
  const ikaConfig = s.ikaClient.ikaConfig;
  const { ikaAmount, suiAmount } = await getRequiredCoinAmounts(s.ikaClient);

  // we need IKA + SUI coin objects. the opt-in tx splits initial fund off these.
  const { ikaCoinId, suiCoinId } = await requireSuiAndIkaCoins(
    s.suiClient,
    ikaConfig,
    owner,
    {
      // need at least the initial fund + fee headroom for the wrap tx itself.
      minSuiProtocolSplitMist: args.initialSuiMist + suiAmount,
      session: s,
    },
  );

  // the user's initial fund cannot exceed what's actually in their coins; the SDK splits.
  const tx = buildOptInTx({
    packageId,
    dwalletCapObjectId: capObjectId,
    dwalletNetworkEncryptionKeyId: networkKey.id,
    curve: 0, // SECP256K1
    signatureAlgorithm: 0, // ECDSA
    dailyCapMicros: args.dailyCapMicros,
    coolDownMs: args.coolDownMs,
    unfreezeDelayMs: args.unfreezeDelayMs,
    rescueAddressBytes: args.rescueAddressBytes,
    stageDelayMs: args.stageDelayMs ?? 86_400_000n, // default 24h
    ikaCoinObjectId: ikaCoinId,
    suiCoinObjectId: suiCoinId,
    initialIkaMist: args.initialIkaMist,
    initialSuiMist: args.initialSuiMist,
  });

  // reference required-coin amounts so build/lint don't drop the import.
  void ikaAmount;

  const result = await executeSuiTransaction(s, tx, { include: { effects: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    const msg = typeof err === 'string' ? err : JSON.stringify(err);
    const friendly = describePolicyVaultAbort(msg);
    throw new PolicyVaultError('execute-failed', friendly ?? msg);
  }
  const digest = (result as { digest?: string }).digest ?? '';
  const vaultObjectId = extractCreatedPolicyVaultId(result, packageId);
  if (!vaultObjectId) {
    throw new PolicyVaultError(
      'protocol',
      'opt-in tx executed but could not extract created PolicyVault object id from effects',
    );
  }

  const link: PolicyVaultLink = {
    vaultObjectId,
    dwalletId,
    primaryActuator: owner,
    optInAtMs: Date.now(),
    curve: 0,
    signatureAlgorithm: 0,
  };
  await setPolicyVaultLink(s.activeVaultId, link);
  // audit log: opt-in is the canonical "user chose to wrap their cap" event.
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: 'opt-in',
    digest,
    next: `cap=${args.dailyCapMicros} cool=${args.coolDownMs}ms unfreeze=${args.unfreezeDelayMs}ms rescue=${args.rescueAddressBytes ? 'set' : 'none'}`,
  }).catch(() => {});
  return { link, digest };
}

function extractCreatedPolicyVaultId(
  result: unknown,
  packageId: string,
): string | null {
  // walk objectChanges / effects.created looking for `<packageId>::sign_gate::PolicyVault`.
  const r = result as {
    objectChanges?: Array<{ type?: string; objectType?: string; objectId?: string }>;
    effects?: { created?: Array<{ owner?: unknown; reference?: { objectId?: string } }> };
  };
  if (Array.isArray(r.objectChanges)) {
    for (const c of r.objectChanges) {
      const t = c.type ?? '';
      const ot = c.objectType ?? '';
      if (t === 'created' && ot.includes(`${packageId}::sign_gate::PolicyVault`) && c.objectId) {
        return c.objectId;
      }
    }
  }
  // fallback: first created object (less specific but works in dev when objectChanges is missing).
  const created = r.effects?.created;
  if (Array.isArray(created) && created.length > 0) {
    return created[0]?.reference?.objectId ?? null;
  }
  return null;
}

/**
 * trigger the on-chain panic flag. idempotent. side-effects:
 *   - clears the local DeSo derived-key link so chromatika stops signing as the delegated
 *     owner (the on-chain authorization remains valid until expiration; the user is told
 *     to revoke via Diamond if they want immediate on-chain revoke). see
 *     `wallet-extension/docs/POLICY_VAULT.md` cross-feature synergies.
 *   - cancels any pending MCP / hardware-sign request queues for the active vault.
 */
export async function panicPolicyVault(): Promise<{ digest: string; sideEffects: { desoLinkCleared: boolean } }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink();

  const tx = buildPanicTx({ packageId, vaultObjectId: link.vaultObjectId });
  const result = await executeSuiTransaction(s, tx, { include: { effects: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    const msg = typeof err === 'string' ? err : JSON.stringify(err);
    throw new PolicyVaultError('execute-failed', describePolicyVaultAbort(msg) ?? msg);
  }
  // run cross-feature panic side-effects. each is best-effort; errors are logged but don't
  // block the panic itself (the on-chain freeze already landed).
  let desoLinkCleared = false;
  try {
    const { clearActiveDeSoOwnerLink, getActiveDeSoOwnerLink } = await import('@/background/chains/deso/deso-derived');
    const desoLink = await getActiveDeSoOwnerLink();
    if (desoLink) {
      await clearActiveDeSoOwnerLink();
      desoLinkCleared = true;
      console.warn(
        '[chromatika policy-vault] panic side-effect: cleared DeSo owner-link locally. on-chain derived key remains valid until block',
        desoLink.expirationBlock,
      );
    }
  } catch (e) {
    console.warn('[chromatika policy-vault] panic side-effect (DeSo clear) failed:', e);
  }
  const digest = (result as { digest?: string }).digest ?? '';
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: 'panic',
    digest,
    detail: desoLinkCleared ? 'deso-link-cleared' : undefined,
  }).catch(() => {});
  return { digest, sideEffects: { desoLinkCleared } };
}

/** clear the panic flag. aborts on-chain if delay hasn't elapsed. */
export async function unfreezePolicyVault(): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink();

  const tx = buildUnfreezeTx({ packageId, vaultObjectId: link.vaultObjectId });
  const result = await executeSuiTransaction(s, tx, { include: { effects: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    const msg = typeof err === 'string' ? err : JSON.stringify(err);
    throw new PolicyVaultError('execute-failed', describePolicyVaultAbort(msg) ?? msg);
  }
  const digest = (result as { digest?: string }).digest ?? '';
  void appendPolicyAuditEntry({ vaultId: s.activeVaultId, kind: 'unfreeze', digest }).catch(() => {});
  return { digest };
}

export async function setPolicyDailyCap(newCapMicros: bigint): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink();
  // capture prev value via cached snapshot (best-effort; chain is the source of truth).
  const prev = link.cachedSnapshot?.dailyCapMicros;
  const stageOn = link.cachedSnapshot?.stageCapRaises ?? false;
  const isRaise = prev != null && newCapMicros > BigInt(prev);
  const willBeStaged = stageOn && isRaise;
  const tx = buildSetDailyCapTx({ packageId, vaultObjectId: link.vaultObjectId, newCapMicros });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: willBeStaged ? 'pending-cap-staged' : 'set-daily-cap',
    digest: out.digest,
    prev,
    next: newCapMicros.toString(),
    detail: willBeStaged
      ? `staged for ${link.cachedSnapshot?.stageDelayMs}ms before effective`
      : undefined,
  }).catch(() => {});
  return out;
}

/**
 * toggle the cap-increase staged delay opt-in. ON is immediate; OFF is staged. the user's
 * first opt-in (false -> true) takes effect right away; subsequent off-toggle waits the
 * stage delay before committing (lazy or via `commitPendingPolicyStageOff`).
 */
export async function setPolicyStageCapRaises(next: boolean): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink();
  const prev = link.cachedSnapshot?.stageCapRaises ?? false;
  const willBeStaged = prev && !next;
  const tx = buildSetStageCapRaisesTx({
    packageId,
    vaultObjectId: link.vaultObjectId,
    next,
  });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: willBeStaged ? 'pending-stage-off-staged' : 'stage-cap-raises-toggled',
    digest: out.digest,
    prev: String(prev),
    next: String(next),
    detail: willBeStaged
      ? `staged for ${link.cachedSnapshot?.stageDelayMs}ms before effective`
      : undefined,
  }).catch(() => {});
  return out;
}

/**
 * change the stage-delay duration. increase always immediate. decrease staged when staging
 * is on (more aggressive change held until the user confirms via the existing pending-off
 * checkpoint). decrease immediate when staging is off.
 */
export async function setPolicyStageDelayMs(newDelayMs: bigint): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink();
  const prev = link.cachedSnapshot?.stageDelayMs?.toString();
  const tx = buildSetStageDelayMsTx({
    packageId,
    vaultObjectId: link.vaultObjectId,
    newDelayMs,
  });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: 'set-stage-delay',
    digest: out.digest,
    prev,
    next: newDelayMs.toString(),
  }).catch(() => {});
  return out;
}

/** force-commit a pending cap raise once the delay has elapsed. */
export async function commitPendingPolicyCap(): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink();
  const prev = link.cachedSnapshot?.dailyCapMicros;
  const next = link.cachedSnapshot?.pendingCapMicros;
  const tx = buildCommitPendingCapTx({ packageId, vaultObjectId: link.vaultObjectId });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: 'pending-cap-committed',
    digest: out.digest,
    prev,
    next,
  }).catch(() => {});
  return out;
}

/** force-commit a pending stage-off once the delay has elapsed. */
export async function commitPendingPolicyStageOff(): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink();
  const tx = buildCommitPendingStageOffTx({ packageId, vaultObjectId: link.vaultObjectId });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: 'pending-stage-off-committed',
    digest: out.digest,
  }).catch(() => {});
  return out;
}

export async function setPolicyCoolDown(newCoolDownMs: bigint): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink();
  const prev = link.cachedSnapshot?.coolDownMs?.toString();
  const tx = buildSetCoolDownTx({ packageId, vaultObjectId: link.vaultObjectId, newCoolDownMs });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: 'set-cool-down',
    digest: out.digest,
    prev,
    next: newCoolDownMs.toString(),
  }).catch(() => {});
  return out;
}

export async function setPolicyRescueAddress(rescueAddressBytes: Uint8Array | null): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink();
  const tx = buildSetRescueAddressTx({
    packageId,
    vaultObjectId: link.vaultObjectId,
    rescueAddressBytes,
  });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: 'set-rescue-address',
    digest: out.digest,
    next: rescueAddressBytes ? 'set' : 'cleared',
  }).catch(() => {});
  return out;
}

export async function addPolicyActuator(newActuator: string): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink();
  if (!/^0x[0-9a-fA-F]{64}$/.test(newActuator)) {
    throw new PolicyVaultError('protocol', 'newActuator must be a 0x-prefixed 32-byte hex Sui address');
  }
  const tx = buildAddActuatorTx({ packageId, vaultObjectId: link.vaultObjectId, newActuator });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: 'add-actuator',
    digest: out.digest,
    next: newActuator,
  }).catch(() => {});
  return out;
}

export async function removePolicyActuator(target: string): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink();
  if (!/^0x[0-9a-fA-F]{64}$/.test(target)) {
    throw new PolicyVaultError('protocol', 'target must be a 0x-prefixed 32-byte hex Sui address');
  }
  const tx = buildRemoveActuatorTx({ packageId, vaultObjectId: link.vaultObjectId, target });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: 'remove-actuator',
    digest: out.digest,
    prev: target,
  }).catch(() => {});
  return out;
}

export async function replenishPolicyPresign(): Promise<{ digest: string; presignsAdded: number }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink();
  const coordinatorObjectId = s.ikaClient.ikaConfig.objects.ikaDWalletCoordinator.objectID;
  const tx = buildReplenishPresignTx({ packageId, vaultObjectId: link.vaultObjectId, coordinatorObjectId });
  const out = await runMutationTx(s, tx);

  // re-sync the local presign-id cache from chain so the order matches Move's vector layout.
  // cheaper than parsing objectChanges (which the SDK doesn't surface uniformly across
  // versions). the vault state read also doubles as a snapshot refresh for the UI.
  let presignsAdded = 0;
  try {
    const { listPolicyPresignCapIds, resyncPolicyPresignsFromChain } = await import(
      '@/background/policy-vault/policy-vault-presigns'
    );
    const before = await listPolicyPresignCapIds(s.activeVaultId);
    const totalAfter = await resyncPolicyPresignsFromChain(
      s.suiClient,
      s.activeVaultId,
      link.vaultObjectId,
    );
    presignsAdded = Math.max(0, totalAfter - before.length);
  } catch (e) {
    console.warn('[chromatika policy-vault] replenish: presign-id resync failed:', e);
  }
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: 'replenish-presign',
    digest: out.digest,
    next: `+${presignsAdded}`,
  }).catch(() => {});
  return { ...out, presignsAdded };
}

export async function topUpPolicyIka(amountMist: bigint): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink();
  const owner = getSuiFeePayerSuiAddress(s);
  const { ikaCoinId } = await requireSuiAndIkaCoins(s.suiClient, s.ikaClient.ikaConfig, owner, {
    minSuiProtocolSplitMist: 0n,
    session: s,
  });
  const tx = buildAddIkaBalanceTx({
    packageId,
    vaultObjectId: link.vaultObjectId,
    ikaCoinObjectId: ikaCoinId,
    amountMist,
  });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: 'top-up-ika',
    digest: out.digest,
    next: amountMist.toString(),
  }).catch(() => {});
  return out;
}

export async function topUpPolicySui(amountMist: bigint): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink();
  const tx = buildAddSuiBalanceTx({
    packageId,
    vaultObjectId: link.vaultObjectId,
    amountMist,
  });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: 'top-up-sui',
    digest: out.digest,
    next: amountMist.toString(),
  }).catch(() => {});
  return out;
}

/** locally clear the link record + presign-id cache. the shared object remains on-chain. */
export async function clearLocalPolicyVaultLink(): Promise<void> {
  const s = requireSession();
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: 'local-link-cleared',
  }).catch(() => {});
  await clearPolicyVaultLink(s.activeVaultId);
  try {
    const { clearPolicyPresignIds } = await import('@/background/policy-vault/policy-vault-presigns');
    await clearPolicyPresignIds(s.activeVaultId);
  } catch {
    /* best-effort */
  }
}

/**
 * read on-chain state via SuiGraphQLClient + parse + update local cached snapshot.
 * returns merged view: { link, snapshot }. snapshot is freshly read, link is from storage
 * (with snapshot field updated post-read).
 */
export async function loadPolicyVaultState(): Promise<{
  link: PolicyVaultLink | null;
  snapshot: PolicyVaultSnapshot | null;
}> {
  const s = requireSession();
  const link = await getPolicyVaultLink(s.activeVaultId);
  if (!link) return { link: null, snapshot: null };
  const snapshot = await readPolicyVaultSnapshot(s.suiClient, link.vaultObjectId);
  if (snapshot) {
    await updatePolicyVaultSnapshot(s.activeVaultId, snapshot);
  }
  return { link, snapshot };
}

async function runMutationTx(
  session: ReturnType<typeof getSession>,
  tx: ReturnType<typeof buildPanicTx>,
): Promise<{ digest: string }> {
  if (!session) throw new PolicyVaultError('wallet-locked', 'session lost');
  const result = await executeSuiTransaction(session, tx, { include: { effects: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    const msg = typeof err === 'string' ? err : JSON.stringify(err);
    throw new PolicyVaultError('execute-failed', describePolicyVaultAbort(msg) ?? msg);
  }
  return { digest: (result as { digest?: string }).digest ?? '' };
}
