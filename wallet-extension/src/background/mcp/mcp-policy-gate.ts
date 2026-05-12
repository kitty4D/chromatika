/**
 * pre-flight Policy Vault check for MCP approve-tier tools (sendEvmTx / sendSolanaTx /
 * signTransaction). when the active vault is policy-gated, an under-cap + non-panicked +
 * non-cool-down request can SKIP THE POPUP entirely: the user already pre-approved up to N
 * USD/day at the on-chain policy module, and the chain enforces the cap. above-cap, panicked,
 * or cool-down -> fall back to the existing popup-gated approval flow.
 *
 * this is the visible payoff of the Policy Vault arc for autonomous agents: the agent does
 * its daily small payments without prompting the user, and only the larger / unusual signs
 * surface the popup. the cap remains the user's pre-set budget for "agent acts on its own."
 *
 * reads `policyVault` snapshot via `getPolicyVaultLink` + `readPolicyVaultSnapshot`. caller
 * is expected to have already validated the request shape; this helper just decides
 * popup-vs-skip based on the policy state.
 */

import { getSession } from '@/background/session';
import { getPolicyPackageConfig, getPolicyVaultLink } from '@/background/policy-vault/policy-vault-storage';
import { readPolicyVaultSnapshot } from '@/background/policy-vault/policy-vault-read';

export type PolicyGateResult =
  | { skipPopup: true; remainingMicros: bigint }
  | { skipPopup: false; reason: 'no-link' | 'no-package' | 'panicked' | 'over-cap' | 'cool-down' | 'snapshot-failed'; detail?: string };

/**
 * decide whether the MCP tool can skip the approval popup. inputs:
 *   - `declaredValueMicros`: the request's USD value in micro-USD. soft policy v0 (caller
 *     resolves from request shape; honest tooling means real numbers, lying tooling can lie
 *     here but the on-chain `sign_with_policy` will still enforce cap on the same value once
 *     it lands, and EVM hard mode strips the lie entirely on Move side).
 *   - `requireUnderCap`: when true (default), we require `remainingMicros >= declaredValueMicros`.
 *     when false (sign-only EVM), we only check non-panicked.
 */
export async function maybeSkipPopupForPolicy(args: {
  declaredValueMicros: bigint;
  requireUnderCap?: boolean;
  /** Which curve's dwallet is about to sign. Picks the correct per-dwallet
   *  PolicyVaultLink. Defaults to SECP256K1 for back-compat (EVM/BTC/DeSo). */
  curve?: 'SECP256K1' | 'ED25519';
}): Promise<PolicyGateResult> {
  const requireUnderCap = args.requireUnderCap !== false;
  const curve = args.curve ?? 'SECP256K1';
  const session = getSession();
  if (!session?.activeVaultId) {
    return { skipPopup: false, reason: 'no-link' };
  }
  const cfg = await getPolicyPackageConfig();
  if (!cfg) {
    return { skipPopup: false, reason: 'no-package' };
  }
  const dwalletId = session.dwalletMeta?.[curve]?.dwalletId;
  if (!dwalletId) {
    return { skipPopup: false, reason: 'no-link' };
  }
  const link = await getPolicyVaultLink(session.activeVaultId, dwalletId);
  if (!link) {
    return { skipPopup: false, reason: 'no-link' };
  }

  // read on-chain snapshot. best-effort: if the read fails (network blip / chain stall),
  // we MUST default to popup; never skip a sign on a stale assumption that the cap allows it.
  let snapshot;
  try {
    snapshot = await readPolicyVaultSnapshot(session.suiClient, link.vaultObjectId);
  } catch (e) {
    return {
      skipPopup: false,
      reason: 'snapshot-failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  if (!snapshot) {
    return { skipPopup: false, reason: 'snapshot-failed', detail: 'snapshot unavailable' };
  }

  if (snapshot.panicked) {
    return { skipPopup: false, reason: 'panicked' };
  }

  if (snapshot.coolDownMs > 0 && snapshot.lastSignAtMs > 0) {
    const earliestNextSign = snapshot.lastSignAtMs + snapshot.coolDownMs;
    if (Date.now() < earliestNextSign) {
      return {
        skipPopup: false,
        reason: 'cool-down',
        detail: `cool-down active for ${Math.ceil((earliestNextSign - Date.now()) / 1000)}s more`,
      };
    }
  }

  const cap = BigInt(snapshot.dailyCapMicros);
  const spent = BigInt(snapshot.spentTodayMicros);
  const remaining = cap > spent ? cap - spent : 0n;

  if (requireUnderCap) {
    // cap = 0 means "no cap configured": skip popup is allowed (sign always lands on chain;
    // the panicked / cool-down checks are the only gates).
    if (cap > 0n && args.declaredValueMicros > remaining) {
      return {
        skipPopup: false,
        reason: 'over-cap',
        detail: `requested ${args.declaredValueMicros} > remaining ${remaining}`,
      };
    }
  }

  return { skipPopup: true, remainingMicros: remaining };
}
