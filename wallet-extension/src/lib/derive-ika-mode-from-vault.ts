import type { IkaBaseMode } from '@/background/ika-base-mode';
import type { VaultSummary } from '@/ui/VaultPicker';

/** ika base for the active vault, source of truth for balances + dWallet data when unlocked. */
export function ikaModeFromActiveVault(
  vaultSummaries: VaultSummary[] | null | undefined,
  activeVaultId: string | null | undefined,
): IkaBaseMode | null {
  if (!vaultSummaries?.length || !activeVaultId) return null;
  const v = vaultSummaries.find((x) => x.id === activeVaultId);
  return v?.baseChain === 'solana' ? 'solana' : v ? 'sui' : null;
}
