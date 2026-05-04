import { getSession } from '@/background/session';
import type { CurveKey } from '@/background/session';
import { loadDwalletMeta, saveDwalletMeta } from '@/background/storage-meta';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';
import { mergeDwalletMeta, persistVaultFromSession } from '@/background/wallet-service';
import { dwalletCapObjectId } from '@/background/chains/dwallet-cap-id';
import {
  chainAddressesForDwalletId,
  deriveChainAddressesFromActivePublicOutput,
  type DwalletCapChainAddresses,
  readDwalletStateKind,
  publicOutputForChainAddresses,
} from '@/background/chains/dwallet-derived-addresses';
import { curveKeyFromDWallet } from '@/background/ika/dwallet-curve-key';
import { chainAddressesForSolanaDwalletId } from '@/background/ika/solana-dwallet-onchain';
import { isSuiIkaDwalletObjectId } from '@/background/ika/solana-dwallet-account-read';
import { getActiveNetworks } from '@/background/network/active-network';
import type { BtcNetwork } from '@/background/chains/bitcoin';

function btcNetworkFromRegistry(btcNetworkId: string): BtcNetwork {
  return btcNetworkId.startsWith('btc-testnet') ? 'testnet' : 'mainnet';
}

export type DiscoveredDWallet = {
  dwalletId: string;
  status: string;
  encryptedShareId?: string;
};

export type OwnedDWalletCapView = {
  capObjectId: string;
  dwalletId: string;
  curve: CurveKey | 'unknown';
  status: string;
  needsZeroTrustCompletion: boolean;
  encryptedShareId?: string;
  /** derived from on-chain `public_output` when present (not only ika `Active` state). */
  chainAddresses?: DwalletCapChainAddresses;
};

async function resolveDwalletIdFromCapObject(capObjectId: string): Promise<string | undefined> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  try {
    const r = await s.suiClient.getObject({
      objectId: capObjectId,
      include: { json: true },
    });
    const j = r.object.json as Record<string, unknown> | null;
    const candidateKeys = ['dwallet_id', 'dwalletId', 'dWalletId'];
    for (const k of candidateKeys) {
      const v = j?.[k];
      if (typeof v === 'string' && v.startsWith('0x') && v.length === 66) return v;
    }
    if (j && typeof j === 'object') {
      for (const v of Object.values(j)) {
        if (typeof v === 'string' && v.startsWith('0x') && v.length === 66 && v !== capObjectId) {
          try {
            await s.ikaClient.getDWallet(v);
            return v;
          } catch {
            /* not a dWallet id */
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

type RawCap = {
  id?: unknown;
  address?: unknown;
  dwallet_id?: string;
  dwalletId?: string;
  dWalletId?: string;
  dwallet?: string;
  dwallet_id_ref?: { id?: string };
};

/** paginate ika `getOwnedDWalletCaps` with `for(;;)` + `break` (CLAUDE.md). */
async function collectOwnedCaps(owner: string): Promise<Array<{ capObjectId: string; dwalletId?: string }>> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const out = new Map<string, { capObjectId: string; dwalletId?: string }>();

  // source of truth for ownership: chain objects by DWalletCap type
  const capTypes = [
    `${s.ikaClient.ikaConfig.packages.ikaDwallet2pcMpcOriginalPackage}::coordinator_inner::DWalletCap`,
    `${s.ikaClient.ikaConfig.packages.ikaDwallet2pcMpcPackage}::coordinator_inner::DWalletCap`,
  ];
  for (const capType of [...new Set(capTypes)]) {
    try {
      let fallbackCursor: string | null = null;
      for (;;) {
        const page: {
          objects: Array<{ objectId: string; json: Record<string, unknown> | null }>;
          hasNextPage: boolean;
          cursor: string | null;
        } = await s.suiClient.listOwnedObjects({
          owner,
          type: capType,
          cursor: fallbackCursor,
          limit: 50,
          include: { json: true },
        });
        for (const obj of page.objects) {
          const capObjectId = obj.objectId;
          out.set(capObjectId, { capObjectId });
        }
        if (!page.hasNextPage || !page.cursor) break;
        fallbackCursor = page.cursor;
      }
    } catch {
      /* continue */
    }
  }

  // enrich with dwallet_id from ika sdk if available
  try {
    let cursor: string | null | undefined;
    for (;;) {
      const page = await s.ikaClient.getOwnedDWalletCaps(owner, cursor ?? undefined, 50);
      for (const cap of page.dWalletCaps) {
        const raw = cap as RawCap;
        const dwalletId =
          raw.dwallet_id
          ?? raw.dwalletId
          ?? raw.dWalletId
          ?? raw.dwallet
          ?? raw.dwallet_id_ref?.id;
        if (typeof dwalletId !== 'string' || !dwalletId.startsWith('0x')) continue;
        try {
          const capObjectId = dwalletCapObjectId(raw);
          const existing = out.get(capObjectId);
          if (existing) out.set(capObjectId, { ...existing, dwalletId });
          else out.set(capObjectId, { capObjectId, dwalletId });
        } catch {
          /* skip malformed cap */
        }
      }
      if (!page.hasNextPage || !page.cursor) break;
      cursor = page.cursor;
    }
  } catch {
    /* keep ownership rows even without enrichment */
  }
  return [...out.values()];
}

/**
 * discover on-chain dWallets owned by this vault's Sui fee payer, filtered by `curve` when the
 * chain object exposes a curve field.
 */
export async function discoverDWalletsForVault(
  vaultId: string,
  curve: CurveKey,
): Promise<DiscoveredDWallet[]> {
  const s = getSession();
  if (!s || s.activeVaultId !== vaultId) throw new Error('Vault not active');

  if (s.activeVaultBaseChain === 'solana') {
    const meta = s.dwalletMeta[curve];
    const id = meta?.dwalletId?.trim();
    if (!id || isSuiIkaDwalletObjectId(id)) return [];
    return [{ dwalletId: id, status: 'Active' }];
  }

  const owner = s.dWalletDiscoverySuiAddress ?? getSuiFeePayerSuiAddress(s);
  const caps = await collectOwnedCaps(owner);
  const out: DiscoveredDWallet[] = [];

  for (const cap of caps) {
    if (!cap.dwalletId) continue;
    const dwalletId = cap.dwalletId;
    try {
      const d = await s.ikaClient.getDWallet(dwalletId);
      const ck = curveKeyFromDWallet(d as { curve?: unknown });
      if (ck === undefined || ck !== curve) continue;

      const state = d.state as { $kind?: string };
      const status = state?.$kind ?? 'unknown';
      let encryptedShareId: string | undefined;
      if (status === 'AwaitingKeyHolderSignature') {
        const zt = d as { encrypted_user_secret_key_share_id?: { id?: string } };
        const inner = zt.encrypted_user_secret_key_share_id;
        if (inner && typeof inner === 'object' && 'id' in inner) {
          const id = (inner as { id: string }).id;
          if (typeof id === 'string') encryptedShareId = id;
        }
      }
      out.push({ dwalletId, status, encryptedShareId });
    } catch {
      /* skip bad object */
    }
  }

  return out;
}

export async function listOwnedDWalletCapsForVault(vaultId: string): Promise<OwnedDWalletCapView[]> {
  const s = getSession();
  if (!s || s.activeVaultId !== vaultId) throw new Error('Vault not active');

  if (s.activeVaultBaseChain === 'solana') {
    const rows: OwnedDWalletCapView[] = [];
    for (const curve of ['SECP256K1', 'ED25519'] as const) {
      const meta = s.dwalletMeta[curve];
      const id = meta?.dwalletId?.trim();
      if (!id || isSuiIkaDwalletObjectId(id)) continue;
      let chainAddresses: DwalletCapChainAddresses | undefined;
      if (s.dwalletSolanaConnection) {
        chainAddresses = await chainAddressesForSolanaDwalletId(s.dwalletSolanaConnection, id);
      }
      rows.push({
        capObjectId: `solana:${curve}:${id}`,
        dwalletId: id,
        curve,
        status: 'Active',
        needsZeroTrustCompletion: false,
        chainAddresses,
      });
    }
    return rows;
  }

  const owner = s.dWalletDiscoverySuiAddress ?? getSuiFeePayerSuiAddress(s);
  const caps = await collectOwnedCaps(owner);
  const rows: OwnedDWalletCapView[] = [];
  const activeReg = await getActiveNetworks();
  const btcNet = btcNetworkFromRegistry(activeReg.btcNetworkId);

  for (const cap of caps) {
    let resolvedDwalletId = cap.dwalletId;
    if (!resolvedDwalletId) {
      resolvedDwalletId = await resolveDwalletIdFromCapObject(cap.capObjectId);
    }
    if (!resolvedDwalletId) {
      rows.push({
        capObjectId: cap.capObjectId,
        dwalletId: 'unknown',
        curve: 'unknown',
        status: 'cap_detected',
        needsZeroTrustCompletion: false,
      });
      continue;
    }
    let curve: CurveKey | 'unknown' = 'unknown';
    let status = 'unknown';
    let encryptedShareId: string | undefined;
    let chainAddresses: DwalletCapChainAddresses | undefined;
    try {
      const d = await s.ikaClient.getDWallet(resolvedDwalletId);
      curve = curveKeyFromDWallet(d as { curve?: unknown }) ?? 'unknown';
      status = readDwalletStateKind(d.state);
      if (status === 'AwaitingKeyHolderSignature') {
        const zt = d as { encrypted_user_secret_key_share_id?: { id?: string } };
        const id = zt.encrypted_user_secret_key_share_id?.id;
        if (typeof id === 'string' && id.startsWith('0x')) encryptedShareId = id;
      }
      if (curve !== 'unknown') {
        const po = publicOutputForChainAddresses(d.state);
        if (po?.length) {
          try {
            chainAddresses = await deriveChainAddressesFromActivePublicOutput(
              curve,
              Uint8Array.from(po),
              btcNet,
            );
          } catch {
            chainAddresses = undefined;
          }
        }
      }
    } catch {
      /* keep unknown fields */
    }
    if (!chainAddresses && curve !== 'unknown') {
      try {
        const pack = await chainAddressesForDwalletId(resolvedDwalletId, btcNet);
        if (Object.keys(pack.addresses).length) chainAddresses = pack.addresses;
      } catch {
        /* noop */
      }
    }
    rows.push({
      capObjectId: cap.capObjectId,
      dwalletId: resolvedDwalletId,
      curve,
      status,
      needsZeroTrustCompletion: status === 'AwaitingKeyHolderSignature',
      encryptedShareId,
      chainAddresses,
    });
  }

  return rows;
}

/**
 * merge chain view into local metadata for one curve. keeps local dwallet id if it disagrees with
 * chain (logs in dev).
 */
export async function mergeDiscoveredDWallets(
  vaultId: string,
  curve: CurveKey,
  discovered: DiscoveredDWallet[],
): Promise<void> {
  const s = getSession();
  if (!s || s.activeVaultId !== vaultId) return;

  const fromStorage = await loadDwalletMeta(vaultId);
  const merged = mergeDwalletMeta(s.dwalletMeta, fromStorage, s.activeVaultBaseChain);
  const local = merged[curve];
  const pick = discovered[0];
  if (!pick) return;

  if (local?.dwalletId && pick.dwalletId !== local.dwalletId) {
    if (import.meta.env.DEV) {
      console.warn(
        '[chromatika] discover merge: local dwallet id differs from chain pick; keeping local',
        curve,
        local.dwalletId,
        pick.dwalletId,
      );
    }
    return;
  }

  const inferredBase: 'sui' | 'solana' =
    pick.dwalletId && !isSuiIkaDwalletObjectId(pick.dwalletId) ? 'solana' : s.activeVaultBaseChain;
  const nextMeta = !local?.dwalletId
    ? {
        ...merged,
        [curve]: {
          baseChain: inferredBase,
          ...merged[curve],
          dwalletId: pick.dwalletId,
          ...(pick.encryptedShareId
            ? { encryptedUserSecretKeyShareId: pick.encryptedShareId }
            : {}),
        },
      }
    : merged;

  s.dwalletMeta = nextMeta;
  await saveDwalletMeta(vaultId, s.dwalletMeta);
  await persistVaultFromSession();
}
