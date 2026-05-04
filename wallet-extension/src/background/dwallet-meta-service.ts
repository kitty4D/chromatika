/**
 * dwallet metadata helpers extracted from `wallet-service.ts`. concerns this module owns:
 *
 *   - merging vault-blob `dwalletMeta` with the per-vault `chrome.storage` overlay so the
 *     session sees the freshest curve state (storage wins on key overlap).
 *   - the `VaultSummary` projection that the UI consumes (count of distinct dWallet ids,
 *     onboarding bridge hints, address pre-fetches for SuiNS / SNS).
 *
 * `wallet-service.ts` re-exports these for back-compat so call sites can migrate at their
 * own pace.
 */

import type { SessionState, CurveKey } from '@/background/session';
import type { BaseChain } from '@/background/ika/ika-adapter';
import type { VaultRecord } from '@/background/vault-types';
import { isSuiIkaDwalletObjectId } from '@/background/ika/solana-dwallet-account-read';

const VAULT_SUMMARY_CURVES: CurveKey[] = ['SECP256K1', 'ED25519'];

/**
 * merge vault + chrome.storage meta per curve; storage wins on key overlap (fresher saves).
 * `vaultBaseChain` seeds `baseChain` when older rows omitted it (Solana vaults must not
 * default to Sui reads). dwallet id shape is the authoritative chain selector when present:
 * Solana base58 ids never route through Sui GraphQL even if `baseChain` says otherwise.
 */
export function mergeDwalletMeta(
  fromVault: SessionState['dwalletMeta'],
  fromStorage: SessionState['dwalletMeta'],
  vaultBaseChain?: BaseChain,
): SessionState['dwalletMeta'] {
  const defaultBase: BaseChain = vaultBaseChain ?? 'sui';
  const curves: CurveKey[] = ['SECP256K1', 'ED25519'];
  const out: SessionState['dwalletMeta'] = { ...fromVault };
  for (const c of curves) {
    const v = fromVault[c];
    const st = fromStorage[c];
    if (!v && !st) continue;
    const merged = { ...(v ?? {}), ...(st ?? {}) } as NonNullable<SessionState['dwalletMeta'][typeof c]>;
    const dwId = typeof merged.dwalletId === 'string' ? merged.dwalletId.trim() : '';
    // never route base58 Solana dWallet ids through Sui GraphQL, infer chain from id shape.
    let baseChain: BaseChain;
    if (dwId && !isSuiIkaDwalletObjectId(dwId)) {
      baseChain = 'solana';
    } else if (dwId && isSuiIkaDwalletObjectId(dwId)) {
      baseChain = 'sui';
    } else {
      baseChain = merged.baseChain ?? defaultBase;
    }
    out[c] = { ...merged, baseChain };
  }
  return out;
}

export type VaultSummary = Pick<VaultRecord, 'id' | 'label' | 'baseChain' | 'accountKind' | 'createdAtMs'> & {
  /** distinct dWallet ids across ika curves (from blob `dwalletMeta`). */
  dwalletCount: number;
  /** Solana-base hardware vault: phone bridge used for ika auto-seed UX hints */
  solanaMobileHardwareBridge?: 'mwa' | 'mwa-remote' | 'walletconnect';
  /** fee / ika root Sui address (m/44'/784'/0'/0'), for SuiNS hints */
  suiAddress0?: string;
  /** standard Solana derivation (m/44'/501'/0'/0'), for SNS / AllDomains hints */
  solanaAddress0?: string;
  /** Sui GraphQL host for this vault's `network` (SuiNS reverse lookup, etc.) */
  suiGraphqlUrl?: string;
  /** active user Solana RPC (for on-chain name lookups) */
  solanaLookupRpcUrl?: string;
  /** both ika `UserShareEncryptionKeys` curves persisted, needed to clone keys into Ledger-first hardware vaults */
  ikaKeysReady?: boolean;
};

/** count distinct dWallet ids across the curves that exist in vault meta. */
export function dwalletCountFromVaultMeta(meta: VaultRecord['dwalletMeta']): number {
  const ids = new Set<string>();
  for (const c of VAULT_SUMMARY_CURVES) {
    const id = meta[c]?.dwalletId?.trim();
    if (id) ids.add(id);
  }
  return ids.size;
}
