/**
 * per-vault user-tunable settings for ika protocol fee payment. Solana-base hardware vaults
 * (Seeker via WC or MWA) sign the user-facing chain transactions on the phone, but ika's gRPC
 * `approve_message` requests run dozens of times per dWallet operation - prompting the phone
 * for each one is awful UX. so Chromatika offers two models, and the user picks at pair time:
 *
 *  - `in_extension`: a deterministic Solana keypair (derived from the same wallet signature
 *    we already capture for the ika seed, but at a different index) lives in the encrypted
 *    vault and pays the gRPC `approve_message` fees automatically. the user funds it once at
 *    pair time, optionally auto-refilled from their phone wallet when the balance dips below
 *    a threshold the user controls. the fee-payer address is derived deterministically so a
 *    restore on a new device lands on the same address - no SOL stranded.
 *
 *  - `seeker_direct`: the phone wallet signs every `approve_message` directly. no fee account,
 *    no auto-refill. maximum trust; many phone prompts (~3-5 per signed transaction, ~5-8 at
 *    DKG). background presign warming is disabled in this mode (presign runs lazily right
 *    before each sign, batched into the prompt chain).
 *
 * storage shape: per-vault under `chromatika_ika_fee_settings_v1_<vaultId>` in
 * `chrome.storage.local`. plaintext - the values are configuration, not secrets. the mode
 * itself is also surfaced in the SessionState at unlock so signing dispatch can branch
 * without re-reading storage on hot paths.
 *
 * note on lamport amounts: `chrome.storage.local` doesn't round-trip bigint, so refill /
 * threshold are persisted as decimal strings and parsed back to bigint on read. keeps
 * lamport precision exact.
 */

export type IkaFeeMode = 'in_extension' | 'seeker_direct';

export interface IkaFeeSettings {
  mode: IkaFeeMode;
  /**
   * only meaningful when `mode === 'in_extension'`. when `true`, mid-operation refills run
   * automatically (the phone signs one transfer tx). when `false`, the user must manually
   * top up via the settings panel; if balance drops below threshold mid-op, the operation
   * surfaces a "fees low" error instead of silently prompting for a refill.
   */
  autoRefill: boolean;
  /** top up to this lamports balance when auto-refilling. ignored when `seeker_direct`. */
  refillLamports: bigint;
  /** trigger auto-refill when current balance drops below this (lamports). */
  thresholdLamports: bigint;
}

/** 0.01 SOL - covers ~100+ ika operations at pre-alpha rates with margin. user-overridable. */
export const DEFAULT_REFILL_LAMPORTS: bigint = 10_000_000n;
/** 0.001 SOL - one order of magnitude below the refill amount. user-overridable. */
export const DEFAULT_THRESHOLD_LAMPORTS: bigint = 1_000_000n;

export function defaultIkaFeeSettings(): IkaFeeSettings {
  return {
    mode: 'in_extension',
    autoRefill: true,
    refillLamports: DEFAULT_REFILL_LAMPORTS,
    thresholdLamports: DEFAULT_THRESHOLD_LAMPORTS,
  };
}

import { VAULT_SCOPED_KEYS } from '@/background/storage';

function storageKey(vaultId: string): string {
  return VAULT_SCOPED_KEYS.ikaFeeSettings(vaultId);
}

/**
 * plain-JSON shape persisted to `chrome.storage.local`. lamports are decimal strings so
 * bigints survive the round-trip (chrome.storage uses structured-clone but bigint support
 * is patchy across runtimes - strings are the safe option).
 */
type IkaFeeSettingsPersisted = {
  mode: IkaFeeMode;
  autoRefill: boolean;
  refillLamports: string;
  thresholdLamports: string;
};

function toPersisted(s: IkaFeeSettings): IkaFeeSettingsPersisted {
  return {
    mode: s.mode,
    autoRefill: s.autoRefill,
    refillLamports: s.refillLamports.toString(),
    thresholdLamports: s.thresholdLamports.toString(),
  };
}

function fromPersisted(raw: unknown): IkaFeeSettings {
  if (!raw || typeof raw !== 'object') return defaultIkaFeeSettings();
  const r = raw as Record<string, unknown>;
  const mode: IkaFeeMode = r['mode'] === 'seeker_direct' ? 'seeker_direct' : 'in_extension';
  const autoRefill = typeof r['autoRefill'] === 'boolean' ? r['autoRefill'] : true;
  let refillLamports = DEFAULT_REFILL_LAMPORTS;
  let thresholdLamports = DEFAULT_THRESHOLD_LAMPORTS;
  try {
    if (typeof r['refillLamports'] === 'string') refillLamports = BigInt(r['refillLamports']);
  } catch {
    // ignore malformed - fall back to default
  }
  try {
    if (typeof r['thresholdLamports'] === 'string') thresholdLamports = BigInt(r['thresholdLamports']);
  } catch {
    // ignore malformed - fall back to default
  }
  // defensive: refuse negative or zero refill amount in `in_extension` mode (would soft-disable
  // auto-refill in a confusing way; the explicit `autoRefill: false` toggle is the right knob).
  if (refillLamports < 0n) refillLamports = DEFAULT_REFILL_LAMPORTS;
  if (thresholdLamports < 0n) thresholdLamports = DEFAULT_THRESHOLD_LAMPORTS;
  return { mode, autoRefill, refillLamports, thresholdLamports };
}

export async function getIkaFeeSettings(vaultId: string): Promise<IkaFeeSettings> {
  const key = storageKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(fromPersisted(r[key]));
    });
  });
}

export async function setIkaFeeSettings(vaultId: string, next: IkaFeeSettings): Promise<void> {
  const key = storageKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: toPersisted(next) }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/**
 * partial update, read-modify-write so caller can set a single field without reconstructing
 * the whole shape. returns the merged settings the caller can re-render with.
 */
export async function updateIkaFeeSettings(
  vaultId: string,
  patch: Partial<IkaFeeSettings>,
): Promise<IkaFeeSettings> {
  const current = await getIkaFeeSettings(vaultId);
  const next: IkaFeeSettings = {
    mode: patch.mode ?? current.mode,
    autoRefill: patch.autoRefill ?? current.autoRefill,
    refillLamports: patch.refillLamports ?? current.refillLamports,
    thresholdLamports: patch.thresholdLamports ?? current.thresholdLamports,
  };
  await setIkaFeeSettings(vaultId, next);
  return next;
}

/** drop the per-vault settings row when a vault is removed. */
export async function clearIkaFeeSettings(vaultId: string): Promise<void> {
  const key = storageKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([key], () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}
