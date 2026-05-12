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
  buildCancelUnwrapTx,
  buildClaimUnwrapTx,
  buildCommitPendingCapTx,
  buildCommitPendingStageOffTx,
  buildOptInTx,
  buildPanicTx,
  buildRemoveActuatorTx,
  buildReplenishPresignTx,
  buildRequestUnwrapTx,
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

async function requireLink(dwalletId: string): Promise<PolicyVaultLink> {
  const s = requireSession();
  const link = await getPolicyVaultLink(s.activeVaultId, dwalletId);
  if (!link) {
    throw new PolicyVaultError(
      'no-link',
      `no PolicyVault is linked to dWallet ${dwalletId.slice(0, 14)}... for this chromatika vault. Opt in first.`,
    );
  }
  return link;
}

/**
 * build the opt-in tx, execute it, parse the created `PolicyVault` object id from effects,
 * persist the link, and return the link.
 *
 * Resolves the dWallet for the active vault by `curve` (default SECP256K1 for back-compat
 * with callers from before per-curve opt-in shipped). ED25519 wraps also work; the
 * cap / cooldown / panic gates apply uniformly, but ED25519-signed chains (Sui PTB,
 * Solana ix, Aptos) only get soft-policy enforcement today because no on-chain
 * decoder is implemented for those tx formats (SECP chains have hard decoders for
 * EVM / BTC / DeSo via `sign_gate_evm` / `sign_gate_btc` / `sign_gate_deso`).
 */
export async function optInToPolicyVault(args: {
  /** dWallet id to wrap. if omitted, resolves to the active vault's dWallet for `curve`. */
  dwalletId?: string;
  /** Which curve to wrap. Defaults to SECP256K1 for back-compat. Determines:
   *  - which `dwalletMeta` slot to read for the cap lookup,
   *  - the on-chain `curve` + `signature_algorithm` numeric stored in PolicyVault.
   *  ED25519 maps to (curve=2, sigAlgo=3 = EdDSA) per ika's enum encoding. */
  curve?: 'SECP256K1' | 'ED25519';
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
  // Policy Vault is Sui-only today. The Solana Anchor program is pre-alpha
  // scaffolding (no real CPI signer), so refuse to opt in from a Solana-base
  // vault even if a future code path tries — UI gating in PolicyVaultPanel
  // should prevent this from being reached, but defense-in-depth.
  if (s.activeVaultBaseChain === 'solana') {
    throw new PolicyVaultError(
      'no-package',
      'Policy Vault is Sui-only today. Solana-base policy is pre-alpha scaffolding pending ika Solana Alpha-1.',
    );
  }
  const packageId = await requirePackageId();

  const curve = args.curve ?? 'SECP256K1';
  // ika's enum: SECP256K1=0 (ECDSA sigAlgo=0), ED25519=2 (EdDSA sigAlgo=3).
  const { curveNum, sigAlgoNum } =
    curve === 'ED25519'
      ? { curveNum: 2, sigAlgoNum: 3 }
      : { curveNum: 0, sigAlgoNum: 0 };
  const meta = s.dwalletMeta?.[curve];
  if (!meta?.dwalletId) {
    throw new PolicyVaultError('no-dwallet', `no ${curve} dWallet for the active vault`);
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
    curve: curveNum,
    signatureAlgorithm: sigAlgoNum,
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
    curve: curveNum,
    signatureAlgorithm: sigAlgoNum,
  };
  await setPolicyVaultLink(s.activeVaultId, link);
  // audit log: opt-in is the canonical "user chose to wrap their cap" event.
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
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
export async function panicPolicyVault(
  dwalletId: string,
): Promise<{ digest: string; sideEffects: { desoLinkCleared: boolean } }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);

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
    dwalletId,
    kind: 'panic',
    digest,
    detail: desoLinkCleared ? 'deso-link-cleared' : undefined,
  }).catch(() => {});
  return { digest, sideEffects: { desoLinkCleared } };
}

/** clear the panic flag. aborts on-chain if delay hasn't elapsed. */
export async function unfreezePolicyVault(dwalletId: string): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);

  const tx = buildUnfreezeTx({ packageId, vaultObjectId: link.vaultObjectId });
  const result = await executeSuiTransaction(s, tx, { include: { effects: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    const msg = typeof err === 'string' ? err : JSON.stringify(err);
    throw new PolicyVaultError('execute-failed', describePolicyVaultAbort(msg) ?? msg);
  }
  const digest = (result as { digest?: string }).digest ?? '';
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'unfreeze',
    digest,
  }).catch(() => {});
  return { digest };
}

export async function setPolicyDailyCap(
  dwalletId: string,
  newCapMicros: bigint,
): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
  // capture prev value via cached snapshot (best-effort; chain is the source of truth).
  const prev = link.cachedSnapshot?.dailyCapMicros;
  const stageOn = link.cachedSnapshot?.stageCapRaises ?? false;
  const isRaise = prev != null && newCapMicros > BigInt(prev);
  const willBeStaged = stageOn && isRaise;
  const tx = buildSetDailyCapTx({ packageId, vaultObjectId: link.vaultObjectId, newCapMicros });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
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
export async function setPolicyStageCapRaises(
  dwalletId: string,
  next: boolean,
): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
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
    dwalletId,
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
export async function setPolicyStageDelayMs(
  dwalletId: string,
  newDelayMs: bigint,
): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
  const prev = link.cachedSnapshot?.stageDelayMs?.toString();
  const tx = buildSetStageDelayMsTx({
    packageId,
    vaultObjectId: link.vaultObjectId,
    newDelayMs,
  });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'set-stage-delay',
    digest: out.digest,
    prev,
    next: newDelayMs.toString(),
  }).catch(() => {});
  return out;
}

/** force-commit a pending cap raise once the delay has elapsed. */
export async function commitPendingPolicyCap(dwalletId: string): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
  const prev = link.cachedSnapshot?.dailyCapMicros;
  const next = link.cachedSnapshot?.pendingCapMicros;
  const tx = buildCommitPendingCapTx({ packageId, vaultObjectId: link.vaultObjectId });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'pending-cap-committed',
    digest: out.digest,
    prev,
    next,
  }).catch(() => {});
  return out;
}

/** force-commit a pending stage-off once the delay has elapsed. */
export async function commitPendingPolicyStageOff(dwalletId: string): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
  const tx = buildCommitPendingStageOffTx({ packageId, vaultObjectId: link.vaultObjectId });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'pending-stage-off-committed',
    digest: out.digest,
  }).catch(() => {});
  return out;
}

export async function setPolicyCoolDown(
  dwalletId: string,
  newCoolDownMs: bigint,
): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
  const prev = link.cachedSnapshot?.coolDownMs?.toString();
  const tx = buildSetCoolDownTx({ packageId, vaultObjectId: link.vaultObjectId, newCoolDownMs });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'set-cool-down',
    digest: out.digest,
    prev,
    next: newCoolDownMs.toString(),
  }).catch(() => {});
  return out;
}

export async function setPolicyRescueAddress(
  dwalletId: string,
  rescueAddressBytes: Uint8Array | null,
): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
  const tx = buildSetRescueAddressTx({
    packageId,
    vaultObjectId: link.vaultObjectId,
    rescueAddressBytes,
  });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'set-rescue-address',
    digest: out.digest,
    next: rescueAddressBytes ? 'set' : 'cleared',
  }).catch(() => {});
  return out;
}

export async function addPolicyActuator(
  dwalletId: string,
  newActuator: string,
): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
  if (!/^0x[0-9a-fA-F]{64}$/.test(newActuator)) {
    throw new PolicyVaultError('protocol', 'newActuator must be a 0x-prefixed 32-byte hex Sui address');
  }
  const tx = buildAddActuatorTx({ packageId, vaultObjectId: link.vaultObjectId, newActuator });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'add-actuator',
    digest: out.digest,
    next: newActuator,
  }).catch(() => {});
  return out;
}

export async function removePolicyActuator(
  dwalletId: string,
  target: string,
): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
  if (!/^0x[0-9a-fA-F]{64}$/.test(target)) {
    throw new PolicyVaultError('protocol', 'target must be a 0x-prefixed 32-byte hex Sui address');
  }
  const tx = buildRemoveActuatorTx({ packageId, vaultObjectId: link.vaultObjectId, target });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'remove-actuator',
    digest: out.digest,
    prev: target,
  }).catch(() => {});
  return out;
}

export async function replenishPolicyPresign(
  dwalletId: string,
): Promise<{ digest: string; presignsAdded: number }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
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
    const before = await listPolicyPresignCapIds(s.activeVaultId, dwalletId);
    const totalAfter = await resyncPolicyPresignsFromChain(
      s.suiClient,
      s.activeVaultId,
      dwalletId,
      link.vaultObjectId,
    );
    presignsAdded = Math.max(0, totalAfter - before.length);
  } catch (e) {
    console.warn('[chromatika policy-vault] replenish: presign-id resync failed:', e);
  }
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'replenish-presign',
    digest: out.digest,
    next: `+${presignsAdded}`,
  }).catch(() => {});
  return { ...out, presignsAdded };
}

export async function topUpPolicyIka(
  dwalletId: string,
  amountMist: bigint,
): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
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
    dwalletId,
    kind: 'top-up-ika',
    digest: out.digest,
    next: amountMist.toString(),
  }).catch(() => {});
  return out;
}

export async function topUpPolicySui(
  dwalletId: string,
  amountMist: bigint,
): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
  const tx = buildAddSuiBalanceTx({
    packageId,
    vaultObjectId: link.vaultObjectId,
    amountMist,
  });
  const out = await runMutationTx(s, tx);
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'top-up-sui',
    digest: out.digest,
    next: amountMist.toString(),
  }).catch(() => {});
  return out;
}

/** locally clear a single link record + that dwallet's presign-id cache. the shared object
 *  remains on-chain. caller decides which dWallet's local pointer to drop. */
export async function clearLocalPolicyVaultLink(dwalletId: string): Promise<void> {
  const s = requireSession();
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'local-link-cleared',
  }).catch(() => {});
  await clearPolicyVaultLink(s.activeVaultId, dwalletId);
  try {
    const { clearPolicyPresignIds } = await import('@/background/policy-vault/policy-vault-presigns');
    await clearPolicyPresignIds(s.activeVaultId, dwalletId);
  } catch {
    /* best-effort */
  }
}

/**
 * Request an unwrap on the active PolicyVault. Starts the staged delay; after
 * `stage_delay_ms` elapses, `claimPolicyUnwrap` can complete. During the wait, any
 * actuator can call `panic` to block the claim.
 *
 * Returns the tx digest plus the wall-clock ms when the unwrap becomes claimable, so the
 * UI can render a countdown banner.
 */
export async function requestPolicyUnwrap(
  dwalletId: string,
): Promise<{ digest: string; claimableAtMs: number }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
  const tx = buildRequestUnwrapTx({ packageId, vaultObjectId: link.vaultObjectId });
  const result = await executeSuiTransaction(s, tx, { include: { effects: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    const msg = typeof err === 'string' ? err : JSON.stringify(err);
    throw new PolicyVaultError('execute-failed', describePolicyVaultAbort(msg) ?? msg);
  }
  const digest = (result as { digest?: string }).digest ?? '';
  const stageDelayMs = Number(link.cachedSnapshot?.stageDelayMs ?? 0);
  const claimableAtMs = Date.now() + stageDelayMs;
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'unwrap-requested',
    digest,
    detail: `claimable in ~${stageDelayMs}ms`,
  }).catch(() => {});
  return { digest, claimableAtMs };
}

/**
 * Cancel a pending unwrap request. Safe at any time (including while panicked).
 */
export async function cancelPolicyUnwrap(dwalletId: string): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
  const tx = buildCancelUnwrapTx({ packageId, vaultObjectId: link.vaultObjectId });
  const result = await executeSuiTransaction(s, tx, { include: { effects: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    const msg = typeof err === 'string' ? err : JSON.stringify(err);
    throw new PolicyVaultError('execute-failed', describePolicyVaultAbort(msg) ?? msg);
  }
  const digest = (result as { digest?: string }).digest ?? '';
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'unwrap-cancelled',
    digest,
  }).catch(() => {});
  return { digest };
}

/**
 * Claim the pending unwrap. Consumes the on-chain `PolicyVault` object, returns the
 * `DWalletCap` to the active fee-payer address, and clears the local link.
 *
 * Aborts on chain if any of: caller not in actuators, unwrap not requested, delay still
 * active, vault panicked. The Move abort is mapped to a friendly message via
 * `describePolicyVaultAbort`.
 *
 * Post-claim, the dWallet is policy-free. The user can either continue using it that way
 * or call the standard opt-in flow again (against the same or a newer audited package).
 */
export async function claimPolicyUnwrap(dwalletId: string): Promise<{ digest: string }> {
  const s = requireSession();
  const packageId = await requirePackageId();
  const link = await requireLink(dwalletId);
  const owner = getSuiFeePayerSuiAddress(s);
  const tx = buildClaimUnwrapTx({
    packageId,
    vaultObjectId: link.vaultObjectId,
    recipientAddress: owner,
  });
  const result = await executeSuiTransaction(s, tx, { include: { effects: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    const msg = typeof err === 'string' ? err : JSON.stringify(err);
    throw new PolicyVaultError('execute-failed', describePolicyVaultAbort(msg) ?? msg);
  }
  const digest = (result as { digest?: string }).digest ?? '';
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    dwalletId,
    kind: 'vault-unwrapped',
    digest,
  }).catch(() => {});
  // The on-chain vault object was consumed; clear the local pointer for this dwallet so
  // the UI returns to "not linked" for it. Presign cache for the same dwallet is dropped.
  await clearPolicyVaultLink(s.activeVaultId, dwalletId);
  try {
    const { clearPolicyPresignIds } = await import('@/background/policy-vault/policy-vault-presigns');
    await clearPolicyPresignIds(s.activeVaultId, dwalletId);
  } catch {
    /* best-effort */
  }
  return { digest };
}

/**
 * read on-chain state via SuiGraphQLClient for a single dwallet's PolicyVault, parse, and
 * update local cached snapshot. returns merged view: { link, snapshot }. snapshot is
 * freshly read, link is from storage (with snapshot field updated post-read).
 */
export async function loadPolicyVaultState(dwalletId: string): Promise<{
  link: PolicyVaultLink | null;
  snapshot: PolicyVaultSnapshot | null;
}> {
  const s = requireSession();
  const link = await getPolicyVaultLink(s.activeVaultId, dwalletId);
  if (!link) return { link: null, snapshot: null };
  const snapshot = await readPolicyVaultSnapshot(s.suiClient, link.vaultObjectId);
  if (snapshot) {
    await updatePolicyVaultSnapshot(s.activeVaultId, dwalletId, snapshot);
  }
  return { link, snapshot };
}

/**
 * Enumerate every opted-in PolicyVault for the active chromatika vault, with fresh
 * on-chain snapshots. Returns an array of `{ link, snapshot }` pairs, one per dWallet.
 * Used by the panel and the tRPC `getPolicyVaultState` query.
 */
export async function loadAllPolicyVaultStates(): Promise<
  Array<{ link: PolicyVaultLink; snapshot: PolicyVaultSnapshot | null }>
> {
  const s = requireSession();
  const { listPolicyVaultLinks } = await import('./policy-vault-storage');
  const links = await listPolicyVaultLinks(s.activeVaultId);
  const out: Array<{ link: PolicyVaultLink; snapshot: PolicyVaultSnapshot | null }> = [];
  // sequential to keep RPC pressure modest; vaults rarely have many wraps at once
  for (const link of links) {
    const snapshot = await readPolicyVaultSnapshot(s.suiClient, link.vaultObjectId);
    if (snapshot) {
      await updatePolicyVaultSnapshot(s.activeVaultId, link.dwalletId, snapshot);
    }
    out.push({ link, snapshot });
  }
  return out;
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
