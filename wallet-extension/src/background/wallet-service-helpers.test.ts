/**
 * tests for the team-funding side of `wallet-service-helpers.ts`. the heavy `finalizeUnlock`
 * path is exercised end-to-end by `wallet-service.test.ts` flow tests; here we isolate the
 * small new surface:
 *
 *   - `retryTeamFundingFromActiveSession` throws when no session
 *   - `retryTeamFundingFromActiveSession` throws when active vault is Solana-base
 *   - the function does NOT throw on a Sui-base session when faucet env vars are unset
 *     (must be safe to call from the banner action even in builds without the funder URL)
 *
 * we mock `@/background/session` and `@/background/onboarding-faucet` so we don't need to
 * spin up the encrypted vault stack or hit a real funder URL just to drive the gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above all imports - module-level test state has to live
// inside vi.hoisted() to be reachable from inside the factory at hoist time.
const { sessionState } = vi.hoisted(() => ({
  sessionState: { current: null as { activeVaultBaseChain: 'sui' | 'solana' } | null },
}));

vi.mock('@/background/session', () => ({
  getSession: () => sessionState.current,
  setSession: (s: typeof sessionState.current) => {
    sessionState.current = s;
  },
}));

vi.mock('@/background/onboarding-faucet', () => ({
  faucetEnvConfigured: () => false,
  requestTeamFunding: async () => ({ kind: 'disabled' as const }),
}));

import { retryTeamFundingFromActiveSession } from '@/background/wallet-service-helpers';

// `wallet-service-helpers.ts` transitively touches chrome.storage via vault-store etc. only at
// call time, but a stub keeps later edits safe if any of those modules ever read storage at
// module load.
function installChromeStub() {
  const g = globalThis as unknown as { chrome?: unknown };
  g.chrome = {
    storage: {
      local: {
        get: (_k: unknown, cb: (r: Record<string, unknown>) => void) => cb({}),
        set: (_i: unknown, cb?: () => void) => cb?.(),
        remove: (_k: unknown, cb?: () => void) => cb?.(),
      },
      session: {
        get: async () => ({}),
        set: async () => undefined,
        remove: async () => undefined,
      },
    },
    runtime: { lastError: undefined },
    alarms: { create: () => undefined, clear: () => undefined, onAlarm: { addListener: () => undefined } },
  };
}

beforeEach(() => {
  sessionState.current = null;
  installChromeStub();
});

afterEach(() => {
  sessionState.current = null;
});

describe('retryTeamFundingFromActiveSession', () => {
  it('throws "Wallet locked" when no session is active', async () => {
    await expect(retryTeamFundingFromActiveSession()).rejects.toThrow(/locked/i);
  });

  it('throws when the active vault is Solana-base', async () => {
    sessionState.current = { activeVaultBaseChain: 'solana' };
    await expect(retryTeamFundingFromActiveSession()).rejects.toThrow(/Sui-base/);
  });

  it('exits cleanly on a Sui-base session even when faucet env is unconfigured', async () => {
    // faucetEnvConfigured() returns false in this test (per the mock at top of file), so
    // `triggerTeamFunding` short-circuits before doing any network work. the public retry
    // surface must be safe to call from the banner action regardless of env state.
    sessionState.current = { activeVaultBaseChain: 'sui' };
    await expect(retryTeamFundingFromActiveSession()).resolves.toBeUndefined();
  });
});
