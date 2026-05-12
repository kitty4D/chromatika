/**
 * tests for `team-funding-offer.ts` - the consent layer between the user and the team faucet.
 * exercises the eligibility rules + persistence behavior with mocked session / storage / faucet
 * env so we don't need a real vault blob or a live worker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sessionState, envState, payloadState, fundingTriggerCalls } = vi.hoisted(() => ({
  sessionState: {
    current: null as null | {
      activeVaultId: string;
      activeVaultBaseChain: 'sui' | 'solana';
      vaultKey: unknown;
      suiKeypair: { toSuiAddress: () => string };
    },
  },
  envState: { configured: true },
  payloadState: { count: 1 },
  fundingTriggerCalls: { count: 0 },
}));

vi.mock('@/background/session', () => ({
  getSession: () => sessionState.current,
  setSession: (s: typeof sessionState.current) => {
    sessionState.current = s;
  },
}));

vi.mock('@/background/onboarding-faucet', () => ({
  faucetEnvConfigured: () => envState.configured,
  requestTeamFunding: async () => ({ kind: 'disabled' as const }),
}));

vi.mock('@/background/vault-store', () => ({
  loadVaultPayloadWithKey: async () => ({
    v: 3 as const,
    vaults: Array.from({ length: payloadState.count }, (_, i) => ({ id: `v${i}` })),
    activeVaultId: 'v0',
  }),
}));

vi.mock('@/background/sui/sui-fee-payer-signing', () => ({
  getSuiFeePayerSuiAddress: (s: { suiKeypair: { toSuiAddress: () => string } }) =>
    s.suiKeypair.toSuiAddress(),
}));

vi.mock('@/background/wallet-service-helpers', () => ({
  triggerTeamFunding: async () => {
    fundingTriggerCalls.count += 1;
  },
}));

import {
  acceptTeamFundingOffer,
  clearTeamFundingDecisionForVault,
  declineTeamFundingOffer,
  getTeamFundingDecision,
  getTeamFundingOffer,
  TEAM_FUNDING_AMOUNTS,
} from '@/background/team-funding-offer';

// in-memory chrome.storage.local stub used by the decision helpers.
function installChromeStub() {
  const localStore: Record<string, unknown> = {};
  const g = globalThis as unknown as { chrome?: unknown };
  g.chrome = {
    storage: {
      local: {
        get: async (k: string | string[] | Record<string, unknown> | null) => {
          if (k == null) return { ...localStore };
          if (typeof k === 'string') return k in localStore ? { [k]: localStore[k] } : {};
          if (Array.isArray(k)) {
            const out: Record<string, unknown> = {};
            for (const key of k) if (key in localStore) out[key] = localStore[key];
            return out;
          }
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(k)) out[key] = key in localStore ? localStore[key] : k[key];
          return out;
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) localStore[k] = v;
        },
        remove: async (k: string | string[]) => {
          const keys = Array.isArray(k) ? k : [k];
          for (const key of keys) delete localStore[key];
        },
      },
      session: {
        get: async () => ({}),
        set: async () => undefined,
        remove: async () => undefined,
      },
    },
  };
}

function setActiveSession(base: 'sui' | 'solana', vaultId = 'v0', address = '0xabc') {
  sessionState.current = {
    activeVaultId: vaultId,
    activeVaultBaseChain: base,
    vaultKey: {},
    suiKeypair: { toSuiAddress: () => address },
  };
}

beforeEach(() => {
  installChromeStub();
  sessionState.current = null;
  envState.configured = true;
  payloadState.count = 1;
  fundingTriggerCalls.count = 0;
});

afterEach(() => {
  sessionState.current = null;
});

describe('getTeamFundingOffer eligibility', () => {
  it('returns locked when no session', async () => {
    const r = await getTeamFundingOffer();
    expect(r).toEqual({ eligible: false, reason: 'locked' });
  });

  it('returns not_sui_base on a Solana-base vault', async () => {
    setActiveSession('solana');
    const r = await getTeamFundingOffer();
    expect(r).toEqual({ eligible: false, reason: 'not_sui_base' });
  });

  it('returns env_unconfigured when faucet env vars are unset', async () => {
    envState.configured = false;
    setActiveSession('sui');
    const r = await getTeamFundingOffer();
    expect(r).toEqual({ eligible: false, reason: 'env_unconfigured' });
  });

  it('returns not_first_vault when vault count is > 1', async () => {
    payloadState.count = 2;
    setActiveSession('sui');
    const r = await getTeamFundingOffer();
    expect(r).toEqual({ eligible: false, reason: 'not_first_vault' });
  });

  it('returns eligible on the happy path', async () => {
    setActiveSession('sui', 'v-first', '0xfeed');
    const r = await getTeamFundingOffer();
    expect(r).toEqual({
      eligible: true,
      vaultId: 'v-first',
      recipientAddress: '0xfeed',
      ikaBaseUnits: TEAM_FUNDING_AMOUNTS.ikaBaseUnits.toString(),
      suiMist: TEAM_FUNDING_AMOUNTS.suiMist.toString(),
    });
  });

  it('returns already_decided after a decision is recorded', async () => {
    setActiveSession('sui', 'v-first');
    await declineTeamFundingOffer();
    const r = await getTeamFundingOffer();
    expect(r).toEqual({ eligible: false, reason: 'already_decided' });
  });
});

describe('accept / decline persistence', () => {
  it('acceptTeamFundingOffer marks accepted AND fires triggerTeamFunding', async () => {
    setActiveSession('sui', 'v-accept', '0xbeef');
    const r = await acceptTeamFundingOffer();
    expect(r).toEqual({ ok: true, recipientAddress: '0xbeef' });
    expect(await getTeamFundingDecision('v-accept')).toBe('accepted');
    // triggerTeamFunding is fired with `void`; the mock increments a counter synchronously.
    expect(fundingTriggerCalls.count).toBe(1);
  });

  it('acceptTeamFundingOffer throws when not eligible (defense in depth)', async () => {
    payloadState.count = 2;
    setActiveSession('sui', 'v-second');
    await expect(acceptTeamFundingOffer()).rejects.toThrow(/not_first_vault/);
    // no funding triggered when ineligible
    expect(fundingTriggerCalls.count).toBe(0);
  });

  it('declineTeamFundingOffer marks declined without calling the funder', async () => {
    setActiveSession('sui', 'v-decline');
    await declineTeamFundingOffer();
    expect(await getTeamFundingDecision('v-decline')).toBe('declined');
    expect(fundingTriggerCalls.count).toBe(0);
  });

  it('clearTeamFundingDecisionForVault removes one entry without touching others', async () => {
    setActiveSession('sui', 'v-a');
    await declineTeamFundingOffer();
    setActiveSession('sui', 'v-b');
    await declineTeamFundingOffer();
    await clearTeamFundingDecisionForVault('v-a');
    expect(await getTeamFundingDecision('v-a')).toBeNull();
    expect(await getTeamFundingDecision('v-b')).toBe('declined');
  });
});
