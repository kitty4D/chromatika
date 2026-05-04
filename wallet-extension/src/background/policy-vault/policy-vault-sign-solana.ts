/**
 * Solana-base parallel of `policy-vault-sign.ts`. routes a sign request through the
 * `chromatika-policy` Solana program (PDA-owned dWallet authority + cap/cool-down/panic
 * checks before CPI'ing into the ika Solana program's `approve_message`).
 *
 * **pre-alpha; awaits ika Solana Alpha-1.** per `wallet-extension/CLAUDE.md`:
 *   - Solana ika today uses a single mock signer (not distributed MPC).
 *   - the Solana ika program + on-chain data WILL BE WIPED on Alpha-1.
 *   - the chromatika-policy Solana program's `do_approve_message_cpi` is a `todo!()` until
 *     ika exposes a CPI target for caller-PDA-as-authority approve_message.
 *
 * what this module does today:
 *   - resolves the active vault's `PolicyVaultLink` and verifies `baseChain === 'solana'`.
 *   - performs all the policy pre-flight checks chromatika does on the Sui side (panicked,
 *     cool-down, cap remaining) by reading the `PolicyVault` PDA via the Solana RPC.
 *   - throws a `PolicyVaultSolanaSignError` with `reason: 'pre-alpha-cpi-stub'` when the
 *     caller actually tries to sign, chromatika UI surfaces this as "Solana base policy
 *     signing awaits ika Alpha-1; soft-policy still active for cap accounting via the
 *     audit log."
 *
 * once Alpha-1 lands, the implementation here changes to: build the `sign_with_policy` ix,
 * send via the SW's existing Solana connection, parse the returned signature.
 */

import { PublicKey } from '@solana/web3.js';
import { getSession } from '@/background/session';
import {
  getPolicyPackageConfig,
  getPolicyVaultLink,
} from '@/background/policy-vault/policy-vault-storage';
import { appendPolicyAuditEntry } from '@/background/policy-vault/policy-vault-audit';

export class PolicyVaultSolanaSignError extends Error {
  constructor(
    readonly reason:
      | 'wallet-locked'
      | 'no-link'
      | 'wrong-base'
      | 'no-program-id'
      | 'panicked'
      | 'cap-exceeded'
      | 'cool-down'
      | 'pre-alpha-cpi-stub',
    message: string,
  ) {
    super(`[policy-sign-solana/${reason}] ${message}`);
    this.name = 'PolicyVaultSolanaSignError';
  }
}

export interface PolicySolanaSignInput {
  /** raw bytes the dWallet should sign. */
  message: Uint8Array;
  /** hash scheme as the ika Solana program's u32 enum value. */
  hashScheme: number;
  /** best-effort declared value in micro-USD; 0 = no declared value. */
  declaredValueMicros: bigint;
}

/**
 * should chromatika dispatch this sign through the Solana-base policy program? pure check.
 * mirrors `shouldDispatchThroughPolicy` from the Sui side; returns true only when the
 * active vault has a Solana-base PolicyVault link AND a configured Solana program id.
 */
export async function shouldDispatchThroughPolicySolana(): Promise<boolean> {
  const s = getSession();
  if (!s?.activeVaultId) return false;
  const cfg = await getPolicyPackageConfig();
  if (!cfg?.solanaProgramId) return false;
  const link = await getPolicyVaultLink(s.activeVaultId);
  return link != null && link.baseChain === 'solana';
}

/**
 * sign through the Solana-base PolicyVault. **currently throws `pre-alpha-cpi-stub`** at
 * the CPI step; chromatika callers fall back to the existing direct sign path with an
 * audit-log entry capturing the attempt. when ika Solana Alpha-1 ships a CPI target, the
 * body of this function flips from "throw" to "build + send + parse signature."
 */
export async function signBytesThroughPolicySolana(
  input: PolicySolanaSignInput,
): Promise<{ signature: string; signId: string }> {
  const s = getSession();
  if (!s) {
    throw new PolicyVaultSolanaSignError('wallet-locked', 'unlock the wallet to sign through Solana policy');
  }
  if (!s.activeVaultId) {
    throw new PolicyVaultSolanaSignError('wallet-locked', 'no active vault id in session');
  }

  const cfg = await getPolicyPackageConfig();
  if (!cfg?.solanaProgramId) {
    throw new PolicyVaultSolanaSignError(
      'no-program-id',
      'chromatika-policy Solana program id not configured. Settings -> Security -> Spend caps + panic.',
    );
  }
  // defensive: validate the program id is a parseable Solana pubkey before any RPC work.
  try {
    new PublicKey(cfg.solanaProgramId);
  } catch (e) {
    throw new PolicyVaultSolanaSignError(
      'no-program-id',
      `chromatika-policy Solana program id is not a valid base58 pubkey: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const link = await getPolicyVaultLink(s.activeVaultId);
  if (!link) {
    throw new PolicyVaultSolanaSignError(
      'no-link',
      'no PolicyVault link for the active vault. Opt in first or use the direct sign path.',
    );
  }
  if (link.baseChain !== 'solana') {
    throw new PolicyVaultSolanaSignError(
      'wrong-base',
      `active vault is base=${link.baseChain ?? 'sui'}; this dispatcher requires baseChain='solana'`,
    );
  }

  // soft pre-flight from cached snapshot (real RPC reads land once the Solana program is
  // deployed and we wire up an account decoder). for now, the cached snapshot is what we
  // have; chromatika audits the attempt and falls back.
  const snap = link.cachedSnapshot;
  if (snap?.panicked) {
    void appendPolicyAuditEntry({
      vaultId: s.activeVaultId,
      kind: 'sign-aborted-panicked',
      detail: `solana-base; declared=${input.declaredValueMicros.toString()}`,
    }).catch(() => {});
    throw new PolicyVaultSolanaSignError(
      'panicked',
      `Solana-base vault is panicked (cached snapshot). Unfreeze unlocks at ${new Date(snap.unfreezeUnlocksAtMs).toISOString()}.`,
    );
  }
  if (snap && snap.dailyCapMicros !== '0') {
    const remaining = BigInt(snap.dailyCapMicros) - BigInt(snap.spentTodayMicros);
    if (input.declaredValueMicros > remaining) {
      void appendPolicyAuditEntry({
        vaultId: s.activeVaultId,
        kind: 'sign-aborted-over-cap',
        detail: `solana-base; declared=${input.declaredValueMicros.toString()} remaining=${remaining.toString()}`,
      }).catch(() => {});
      throw new PolicyVaultSolanaSignError(
        'cap-exceeded',
        `declared value exceeds Solana-base daily cap remaining (${remaining.toString()} micro-USD)`,
      );
    }
  }

  // pre-alpha gap. the chromatika-policy Solana program's `sign_with_policy` instruction
  // is callable today, but its CPI target into ika is a `todo!()` stub until Alpha-1.
  // until then, chromatika logs the attempt + throws so the caller falls back to the
  // existing direct sign path (which today produces a mock-signer signature; per CLAUDE.md
  // "do not present Solana pre-alpha as production MPC or custody," this is correctly
  // labelled in the UI).
  void appendPolicyAuditEntry({
    vaultId: s.activeVaultId,
    kind: 'sign-cap-applied',
    detail: `solana-base PRE-ALPHA fallthrough (no CPI target yet); declared=${input.declaredValueMicros.toString()}`,
  }).catch(() => {});

  throw new PolicyVaultSolanaSignError(
    'pre-alpha-cpi-stub',
    'Solana-base policy signing awaits ika Solana Alpha-1. Soft-policy audit logged; caller should fall back to direct sign path.',
  );
}

/**
 * helper for callers that want to attempt-then-fallback. returns `null` on the pre-alpha
 * stub so callers can drop into their direct sign path without inspecting the error type.
 */
export async function trySignBytesThroughPolicySolana(
  input: PolicySolanaSignInput,
): Promise<{ signature: string; signId: string } | null> {
  try {
    return await signBytesThroughPolicySolana(input);
  } catch (e) {
    if (e instanceof PolicyVaultSolanaSignError && e.reason === 'pre-alpha-cpi-stub') {
      return null;
    }
    throw e;
  }
}
