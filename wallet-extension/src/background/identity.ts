import type { SessionState } from '@/background/session';
import { resolveDwalletIdentity } from '@/background/dwallet-identity';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';

/** ika on-chain `dWallet.curve` u32; ED25519 maps to curveNumber 2 in ika SDK config. */
const ED25519_CURVE_NUMBER = 2;

/**
 * user-facing Sui receive / dapp identity: ED25519 dWallet-derived address when that dWallet is Active,
 * otherwise the HD fee-payer address (gas account).
 */
export async function resolveCanonicalSuiReceiveAddress(s: SessionState): Promise<{
  address: string;
  source: 'dwallet_ed25519_active' | 'hd_fee_payer';
}> {
  const id = s.dwalletMeta.ED25519?.dwalletId ?? (await resolveDwalletIdentity('ED25519').then((r) => r.dwalletId).catch(() => null));
  if (!id) {
    return { address: getSuiFeePayerSuiAddress(s), source: 'hd_fee_payer' };
  }
  try {
    const d = await s.ikaClient.getDWallet(id);
    const kind = (d.state as { $kind: string }).$kind;
    if (kind === 'Active' && Number(d.curve) === ED25519_CURVE_NUMBER) {
      return { address: s.ikaShareKeys.ED25519.getSuiAddress(), source: 'dwallet_ed25519_active' };
    }
  } catch {
    /* use fee payer */
  }
  return { address: getSuiFeePayerSuiAddress(s), source: 'hd_fee_payer' };
}
