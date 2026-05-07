/**
 * fire-once HTTP call to the team funder Worker that drips a small amount of mainnet SUI + IKA
 * to a freshly-onboarded chromatika user's Sui address. paired with the Worker at
 * `funder/` (Cloudflare Worker, see `funder/README.md`).
 *
 * surface area:
 *   - `faucetEnvConfigured()` -> boolean. lets callers cheaply skip when env vars are absent
 *     (dev builds, forks without the prod token bundled, etc.) without paying a fetch.
 *   - `requestTeamFunding(suiAddress)` -> structured result. fires the POST, returns a typed
 *     outcome the caller can map to `OperationProgressBanner` states. throws never; the
 *     `kind: 'error'` branch carries the user-facing message.
 *
 * design notes:
 *   - we do NOT retry on 5xx here. the user can retry from the banner, and a silent retry
 *     loop in the SW would burn fetch budget without giving them feedback.
 *   - 429 with `reason: 'already_funded'` is treated as "ok skip" (kind: 'skipped'), since a
 *     repeat onboarding on the same address legitimately should not refund. callers don't
 *     need a banner for this case.
 *   - the bearer token is bundled in the chromatika build (VITE_FUNDER_TOKEN). it is NOT the
 *     primary anti-abuse layer - that's the Worker's per-address one-shot + daily caps.
 *     treating the token as public is intentional and documented in the Worker README.
 */

const FUNDER_URL = (import.meta.env.VITE_FUNDER_URL as string | undefined)?.trim() ?? '';
const FUNDER_TOKEN = (import.meta.env.VITE_FUNDER_TOKEN as string | undefined)?.trim() ?? '';

/** quick check for "is this build wired up to a faucet?" - cheap, no network call. */
export function faucetEnvConfigured(): boolean {
  return Boolean(FUNDER_URL && FUNDER_TOKEN);
}

export type FaucetSuccess = {
  kind: 'success';
  digest: string;
  ikaSent: string;
  suiSent: string;
};

export type FaucetSkipped = {
  kind: 'skipped';
  /** structured reason: `already_funded`, `daily_cap`, `lifetime_cap`. */
  reason: string;
};

export type FaucetDisabled = {
  kind: 'disabled';
};

export type FaucetError = {
  kind: 'error';
  /** user-facing message, ready to drop into a banner. */
  message: string;
  /** HTTP status when one was returned; null on network errors. */
  status: number | null;
};

export type FaucetOutcome = FaucetSuccess | FaucetSkipped | FaucetDisabled | FaucetError;

/**
 * call the funder. always resolves; never throws. callers translate the outcome into a banner.
 *
 * @param suiAddress - canonical Sui address of the new user's fee payer (`0x...64hex`).
 */
export async function requestTeamFunding(suiAddress: string): Promise<FaucetOutcome> {
  if (!faucetEnvConfigured()) {
    return { kind: 'disabled' };
  }
  const url = `${FUNDER_URL.replace(/\/$/, '')}/fund`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${FUNDER_TOKEN}`,
      },
      body: JSON.stringify({ recipientAddress: suiAddress }),
    });
  } catch (e) {
    return {
      kind: 'error',
      message: `Could not reach team funder: ${(e as Error).message}`,
      status: null,
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* leave body null; we'll still surface res.status */
  }

  if (res.status === 200 && body && typeof body === 'object') {
    const b = body as Partial<FaucetSuccess>;
    if (typeof b.digest === 'string' && typeof b.ikaSent === 'string' && typeof b.suiSent === 'string') {
      return { kind: 'success', digest: b.digest, ikaSent: b.ikaSent, suiSent: b.suiSent };
    }
    return { kind: 'error', message: 'Funder returned 200 with unexpected body shape', status: 200 };
  }

  if (res.status === 429 && body && typeof body === 'object') {
    const reason = (body as { reason?: string }).reason ?? 'rate_limited';
    return { kind: 'skipped', reason };
  }

  const detail =
    (body && typeof body === 'object' && typeof (body as { detail?: string }).detail === 'string'
      ? (body as { detail: string }).detail
      : null)
    ?? (body && typeof body === 'object' && typeof (body as { error?: string }).error === 'string'
      ? (body as { error: string }).error
      : null);
  return {
    kind: 'error',
    message: detail ? `Funder ${res.status}: ${detail}` : `Funder ${res.status}`,
    status: res.status,
  };
}
