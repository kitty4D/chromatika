/**
 * Formatting helpers shared by Policy Vault UI surfaces (`PolicyVaultPanel`,
 * `PolicyVaultBanner`, `PostCreatePolicyVaultPrompt`). Pulled out so the post-
 * creation modal and the settings panel render the same defaults in lockstep.
 */

/** micro-USD bigint string -> human USD with up to 6 decimal places (trailing zeros stripped). */
export function microsToUsd(microsStr: string): string {
  try {
    const n = BigInt(microsStr);
    if (n === 0n) return '0';
    const whole = n / 1_000_000n;
    const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return `${whole.toString()}${frac ? '.' + frac : ''}`;
  } catch {
    return microsStr;
  }
}

/** milliseconds -> compact human duration ("now", "Ns", "Nm", "N.Nh", "N.Nd"). Used by
 *  banner countdowns where space is tight; for body copy use `fmtMsVerbose`. */
export function fmtMs(ms: number): string {
  if (ms <= 0) return 'now';
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

/** milliseconds -> verbose human duration with units spelled out ("1 minute", "7 days").
 *  "m" is ambiguous with month at a glance; "1m" reads as one month to some users. Use
 *  this in body copy where the duration is being explained / set as a default value. */
export function fmtMsVerbose(ms: number): string {
  if (ms <= 0) return 'instant';
  if (ms < 60_000) {
    const s = Math.ceil(ms / 1000);
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  if (ms < 3_600_000) {
    const m = Math.round(ms / 60_000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (ms < 86_400_000) {
    const h = ms / 3_600_000;
    const r = Number.isInteger(h) ? h.toString() : h.toFixed(1);
    return `${r} hour${h === 1 ? '' : 's'}`;
  }
  const d = ms / 86_400_000;
  const r = Number.isInteger(d) ? d.toString() : d.toFixed(1);
  return `${r} day${d === 1 ? '' : 's'}`;
}

/** mist (1e-9 IKA/SUI base unit) bigint string -> coin amount with 4 decimal places. */
export function fmtMist(mistStr: string): string {
  try {
    const n = BigInt(mistStr);
    return `${(Number(n) / 1e9).toFixed(4)}`;
  } catch {
    return mistStr;
  }
}
