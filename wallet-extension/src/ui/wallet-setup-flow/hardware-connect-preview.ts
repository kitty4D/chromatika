import { isWcEnabled } from '@/config/wc';
import type { WalletSetupMode } from './internal';
import type { VaultListRow } from './internal';

/**
 * human-readable list of hardware paths the user will see after tapping "connect other hardware wallet".
 * mirrors availability in `HardwareStep` but only includes options they can actually use.
 */
export function hardwareConnectOptionLabels(params: {
  ikaBase: 'sui' | 'solana';
  mode: WalletSetupMode;
  /** full vault list (addVault), gates "Solana Mobile (this phone)" for users not on Seeker/MWA yet */
  vaultSummaries?: VaultListRow[] | null;
}): string[] {
  const { ikaBase, mode, vaultSummaries } = params;
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
  const isBootstrap = mode === 'bootstrap';
  const wcEnabled = isWcEnabled();
  const mwaRemoteEnabled = (import.meta.env.VITE_ENABLE_MWA_REMOTE as string | undefined) === 'true';
  const list = vaultSummaries ?? [];
  const hasSeekerOrMwaVault = list.some(
    (v) => v.solanaMobileHardwareBridge === 'mwa' || v.solanaMobileHardwareBridge === 'mwa-remote',
  );

  const out: string[] = [];
  if (ikaBase === 'solana') {
    if (wcEnabled) out.push('WalletConnect');
    if (!isAndroid && mwaRemoteEnabled) out.push('Seeker (QR pair)');
    if (isAndroid && (isBootstrap || hasSeekerOrMwaVault)) out.push('Solana Mobile (this phone)');
    if (!isBootstrap) {
      out.push('Ledger');
      out.push('Trezor');
    }
  } else if (!isBootstrap) {
    out.push('Ledger (Sui app)');
  }
  return out;
}
