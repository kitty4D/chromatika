/**
 * Frozen `getPolicyVaultState`-shaped snapshot for marketing / playwright recordings (`policyPanelDemo=1`).
 * Uses the shipped sui-mainnet builtin row so the demo matches what users see when a package exists
 * but this dWallet is not wrapped yet.
 */

import { getBuiltinPolicyForSui } from '@/background/policy-vault/policy-vault-builtin';
import type { PolicyVaultPanelState } from '@/ui/components/PolicyVaultPanel';

function makePreOptInPolicyDemoState(): PolicyVaultPanelState {
  const b = getBuiltinPolicyForSui('mainnet');
  if (!b) {
    throw new Error('POLICY_PANEL_PRE_OPT_IN_DEMO: missing sui-mainnet builtin registry entry');
  }
  return {
    packageConfig: {
      packageId: b.identifier,
      setAtMs: Date.parse(b.publishedAt) || Date.now(),
      label: b.label,
      builtin: true,
      auditHash: b.bytecodeHashSha256,
    },
    links: [],
    activeVaultBaseChain: 'sui',
  };
}

export const POLICY_PANEL_PRE_OPT_IN_DEMO: PolicyVaultPanelState = makePreOptInPolicyDemoState();
