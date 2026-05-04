import type { IkaBaseMode } from '@/background/ika-base-mode';
import { WalletSetupFlow } from '@/ui/wallet-setup-flow';

/**
 * Shown when the user picks Sui or Solana in the header but no vault exists for that ika base chain.
 * Completing the flow calls `addVault` with the matching `baseChain` and becomes active.
 */
export function NeedIkaBaseVaultGate({
  chain,
  onCancel,
  onVaultReady,
}: {
  chain: IkaBaseMode;
  onCancel: () => void;
  onVaultReady: () => void;
}) {
  const label = chain === 'solana' ? 'Solana (devnet ika pre-alpha)' : 'Sui';
  return (
    <div className="sp-page" style={{ padding: '0 var(--ch-content-pad, 14px) 24px', maxWidth: 520, margin: '0 auto' }}>
      <button type="button" className="sp-backBtn" onClick={onCancel}>
        ← back
      </button>
      <h2 className="sp-pageTitle" style={{ marginTop: 4 }}>
        Add a {label} dWallet Vault
      </h2>
      <WalletSetupFlow
        surface="sidepanel"
        mode="addVault"
        vaultBaseChainOverride={chain}
        onVaultReady={onVaultReady}
        onDismiss={onCancel}
      />
    </div>
  );
}
