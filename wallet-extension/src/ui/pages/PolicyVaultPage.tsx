/**
 * dedicated bottom-nav surface for the on-chain Policy Vault. Settings used to host this
 * panel inline; it grew into a primary security feature (caps, panic, rescue address,
 * actuators, audit log) and earned its own tab. the title-bar Settings cog still routes
 * to the regular Settings page for the long-tail prefs.
 */

import { PolicyVaultPanel } from '@/ui/components/PolicyVaultPanel';

export function PolicyVaultPage() {
  return (
    <div className="sp-page sp-page--policyVault">
      <div className="sp-pageHeader">
        <h2 className="sp-pageTitle">policy vault</h2>
        <p className="sp-muted" style={{ fontSize: 12, lineHeight: 1.5, margin: '4px 0 12px' }}>
          on-chain spend caps + panic button + rescue address. signs every dapp tx through a
          shared Move object that enforces the rules even if the wallet UI is compromised.
        </p>
      </div>
      <PolicyVaultPanel />
    </div>
  );
}
