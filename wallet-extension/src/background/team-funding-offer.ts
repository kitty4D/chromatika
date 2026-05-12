/**
 * team-funding consent surface. the wallet asks the user, once per vault, whether they want
 * to receive a small mainnet SUI + IKA drip from chromatika so they can build their first
 * dWallets without buying tokens. ONLY shows on the user's FIRST vault on this device
 * (vault count === 1). additional vaults never see the offer.
 *
 * v1 contract:
 *   - `getTeamFundingOffer()` returns an eligibility + amounts snapshot. UI calls this on
 *     mount; banner only renders when `eligible: true`.
 *   - `acceptTeamFundingOffer()` re-checks eligibility server-side, marks 'accepted' BEFORE
 *     firing the fetch (so a double-tap on Yes doesn't double-spend), then runs the existing
 *     `triggerTeamFunding` flow which surfaces progress through the OperationProgressBanner.
 *   - `declineTeamFundingOffer()` just records 'declined' so the banner never returns for
 *     that vault id.
 *
 * decisions persist in `chrome.storage.local` under `STORAGE_KEYS.TEAM_FUNDING_DECISIONS_V1`
 * as `{ [vaultId]: 'accepted' | 'declined' }`. surviving SW restarts keeps the prompt from
 * re-appearing every time the side panel reopens.
 *
 * FUNDING amounts MUST match `funder/src/config.ts` (FUNDING_IKA + FUNDING_SUI). bump them
 * together when the quarterly mainnet calibration shifts the per-session minima. the wallet
 * does not query the worker for amounts at runtime; this duplication is intentional so the
 * banner can render without a network round-trip.
 */

import { getSession } from '@/background/session';
import { loadVaultPayloadWithKey } from '@/background/vault-store';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';
import { faucetEnvConfigured } from '@/background/onboarding-faucet';
import { STORAGE_KEYS } from '@/background/storage';

/**
 * per-recipient drip, mirrored from `funder/src/config.ts` (FUNDING_IKA + FUNDING_SUI).
 * last calibrated 2026-05-11 against mainnet. update both files together via the
 * `wallet-extension/scripts/calibrate-funder-pricing.mjs` calibration script.
 */
export const TEAM_FUNDING_AMOUNTS = {
  /** 0.275 IKA per session * 12x scope multiplier = 3.3 IKA. */
  ikaBaseUnits: 3_300_000_000n,
  /** 0.01 SUI per session * 12x scope multiplier = 0.12 SUI. */
  suiMist: 120_000_000n,
} as const;

const DECISION_KEY = STORAGE_KEYS.TEAM_FUNDING_DECISIONS_V1;

export type TeamFundingDecision = 'accepted' | 'declined';

type DecisionMap = Record<string, TeamFundingDecision>;

async function readDecisions(): Promise<DecisionMap> {
  try {
    const r = await chrome.storage.local.get(DECISION_KEY);
    const raw = r?.[DECISION_KEY];
    if (!raw || typeof raw !== 'object') return {};
    const out: DecisionMap = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === 'accepted' || v === 'declined') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function writeDecision(vaultId: string, decision: TeamFundingDecision): Promise<void> {
  const current = await readDecisions();
  current[vaultId] = decision;
  await chrome.storage.local.set({ [DECISION_KEY]: current });
}

/** returns `null` if no decision recorded yet. */
export async function getTeamFundingDecision(vaultId: string): Promise<TeamFundingDecision | null> {
  const all = await readDecisions();
  return all[vaultId] ?? null;
}

export type TeamFundingOffer =
  | {
      eligible: true;
      vaultId: string;
      recipientAddress: string;
      /** stringified bigints so the tRPC superjson layer doesn't need a per-call codec for them. */
      ikaBaseUnits: string;
      suiMist: string;
    }
  | {
      eligible: false;
      /** structured reason so the UI can log / branch if needed. */
      reason:
        | 'locked'
        | 'not_sui_base'
        | 'env_unconfigured'
        | 'not_first_vault'
        | 'already_decided';
    };

/**
 * decide whether the active session should see the funding offer. eligibility rules:
 *
 *   1. session is unlocked
 *   2. active vault is Sui-base (Solana-base routes through a different funder model)
 *   3. funder env vars are baked into the build (`VITE_FUNDER_URL` + `VITE_FUNDER_TOKEN`)
 *   4. total vault count on this device is exactly 1 (this IS the first vault)
 *   5. no decision has been recorded for this vault id yet
 *
 * the worker enforces per-address one-shot on its own; rule 4 is a UX rule so additional
 * vaults never see the prompt regardless of address.
 */
export async function getTeamFundingOffer(): Promise<TeamFundingOffer> {
  const session = getSession();
  if (!session) return { eligible: false, reason: 'locked' };
  if (session.activeVaultBaseChain !== 'sui') return { eligible: false, reason: 'not_sui_base' };
  if (!faucetEnvConfigured()) return { eligible: false, reason: 'env_unconfigured' };

  const payload = await loadVaultPayloadWithKey(session.vaultKey);
  if (payload.vaults.length !== 1) return { eligible: false, reason: 'not_first_vault' };

  const decision = await getTeamFundingDecision(session.activeVaultId);
  if (decision !== null) return { eligible: false, reason: 'already_decided' };

  return {
    eligible: true,
    vaultId: session.activeVaultId,
    recipientAddress: getSuiFeePayerSuiAddress(session),
    ikaBaseUnits: TEAM_FUNDING_AMOUNTS.ikaBaseUnits.toString(),
    suiMist: TEAM_FUNDING_AMOUNTS.suiMist.toString(),
  };
}

/**
 * user said yes. records the decision FIRST (so a fast double-tap can't re-enter), then runs
 * the same `triggerTeamFunding` flow used by the legacy auto-trigger and the OperationProgressBanner
 * retry action - the banner already owns progress + retry surface, so this returns once the
 * fetch is queued, not awaited to completion.
 */
export async function acceptTeamFundingOffer(): Promise<{ ok: true; recipientAddress: string }> {
  const offer = await getTeamFundingOffer();
  if (!offer.eligible) {
    throw new Error(`Team funding offer not eligible: ${offer.reason}`);
  }
  await writeDecision(offer.vaultId, 'accepted');
  const { triggerTeamFunding } = await import('@/background/wallet-service-helpers');
  const session = getSession();
  if (!session) throw new Error('Wallet locked');
  void triggerTeamFunding(session);
  return { ok: true, recipientAddress: offer.recipientAddress };
}

/** user said no. just records the decision so the banner never returns for this vault. */
export async function declineTeamFundingOffer(): Promise<{ ok: true }> {
  const session = getSession();
  if (!session) throw new Error('Wallet locked');
  await writeDecision(session.activeVaultId, 'declined');
  return { ok: true };
}

/** vault removal hook: clears the per-vault decision so the storage doesn't accumulate forever. */
export async function clearTeamFundingDecisionForVault(vaultId: string): Promise<void> {
  const current = await readDecisions();
  if (!(vaultId in current)) return;
  delete current[vaultId];
  await chrome.storage.local.set({ [DECISION_KEY]: current });
}
