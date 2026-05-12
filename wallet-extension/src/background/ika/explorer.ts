import { PublicKey } from '@solana/web3.js';
import { getSession } from '@/background/session';
import { getDwalletNetworkSettings, resolveSolanaRpcUrl } from '@/background/network/tier-network-settings';
import {
  createSuiGraphQLClientFromRegistryNetworkId,
  queryObjectsByTypeGraphQL,
  queryTransactionBlocksGraphQL,
  type SuiTxSummary,
} from '@/background/sui-client';
import { curveKeyFromDWallet } from '@/background/ika/dwallet-curve-key';
import { deriveChainAddressesFromActivePublicOutput } from '@/background/chains/dwallet-derived-addresses';
import type { DwalletCapChainAddresses } from '@/background/chains/dwallet-derived-addresses';
import { listOwnedDWalletCapsForVault } from '@/background/ika/dwallet-discovery';
import { SOLANA_PREALPHA_GRPC_URL, SOLANA_PREALPHA_PROGRAM_ID } from '@/background/ika/solana-grpc-client';
import {
  chainAddressesForSolanaDwalletId,
  fetchSolanaDWalletAccount,
} from '@/background/ika/solana-dwallet-onchain';
import {
  ENCRYPT_SOLANA_GRPC_URL,
  ENCRYPT_SOLANA_PROGRAM_ID,
  ENCRYPT_SOLANA_RPC_URL,
} from '@/background/encrypt/encrypt-constants';

const SAMPLE_LIMIT_DEFAULT = 40;
const IKA_COIN_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';

export type ChromaLabRefs = {
  ikaBase: 'sui' | 'solana';
  networkIds: {
    sui: string;
    solana: string;
  };
  sui: {
    packageRefs: Array<{ label: string; id: string }>;
    objectRefs: Array<{ label: string; id: string }>;
    ikaCoinType: string;
  };
  solana: {
    programRefs: Array<{ label: string; id: string }>;
    grpcUrl: string;
  };
  encrypt: {
    programId: string;
    grpcUrl: string;
    rpcUrl: string;
  };
};

export type ExplorerDwalletRow = {
  dwalletId: string;
  curve: 'SECP256K1' | 'ED25519' | 'unknown';
  stateKind: string;
  txCount: number;
  lastSeenMs: number | null;
  lastSeenDigest: string | null;
  createdAtMs: number | null;
  createdDigest: string | null;
  chainAddresses?: DwalletCapChainAddresses;
};

export type SuiExplorerTransactionRow = {
  digest: string;
  timestampMs: number | null;
  status: 'success' | 'failure';
  dwalletIds: string[];
  createdDwalletIds: string[];
  /** quick hint from ika-shaped ids in this tx */
  signal: 'create' | 'event' | 'mixed' | 'empty';
};

export type SuiExplorerOverview = {
  sample: {
    coordinatorId: string;
    transactionCount: number;
    successCount: number;
    failureCount: number;
    sampledLimit: number;
    mergeSources: Array<'ChangedObject' | 'FromAddress'>;
    fetchedRaw: number;
    dedupedTransactions: number;
  };
  heuristicSummary: {
    uniqueDwalletIds: number;
    explain: string;
  };
  lists: {
    mostRecentCreated: ExplorerDwalletRow[];
    mostActiveInSample: ExplorerDwalletRow[];
    mostRecentlyTouched: ExplorerDwalletRow[];
    awaitingSignature: ExplorerDwalletRow[];
  };
  recentTransactions: SuiExplorerTransactionRow[];
};

export type SuiDwalletDetail = {
  dwalletId: string;
  curve: 'SECP256K1' | 'ED25519' | 'unknown';
  stateKind: string;
  previousTransaction: string | null;
  ownerType: string | null;
  chainAddresses?: DwalletCapChainAddresses;
  publicOutputB64?: string;
  encryptedShareId?: string;
  isOwnedByActiveVault: boolean;
  activeVaultCapObjectId?: string;
  recentTransactions: SuiExplorerTransactionRow[];
};

export type SolanaProgramRecentOverview = {
  programId: string;
  recentSignatures: Array<{
    signature: string;
    slot: number;
    blockTimeMs: number | null;
    status: 'success' | 'failure';
  }>;
};

export type SolanaDwalletDetail = {
  dwalletId: string;
  curve: 'SECP256K1' | 'ED25519';
  publicOutputHex: string;
  chainAddresses?: DwalletCapChainAddresses;
  lamports: number;
  executable: boolean;
  ownerProgramId: string;
  recentSignatures: Array<{
    signature: string;
    slot: number;
    blockTimeMs: number | null;
    status: 'success' | 'failure';
  }>;
};

function collectHexIds(value: unknown, out: Set<string>) {
  if (typeof value === 'string' && value.startsWith('0x') && value.length === 66) {
    out.add(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectHexIds(nested, out);
  }
}

function idsFromEvents(events: unknown): string[] {
  const rows: unknown[] = Array.isArray(events) ? events : (events as { nodes?: unknown[] } | undefined)?.nodes ?? [];
  const out = new Set<string>();
  for (const row of rows) {
    const parsed =
      (row as { parsedJson?: unknown }).parsedJson
      ?? (row as { json?: unknown }).json
      ?? (row as { contents?: { json?: unknown } }).contents?.json;
    collectHexIds(parsed, out);
  }
  return [...out];
}

function toHex(u8: Uint8Array): string {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function getSuiExplorerClient() {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const settings = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  const network = settings.suiNetworkId;
  return {
    session: s,
    networkId: network,
    coordinatorId: s.ikaClient.ikaConfig.objects.ikaDWalletCoordinator.objectID,
    client: createSuiGraphQLClientFromRegistryNetworkId(network),
  };
}

function packageRefsFromIkaConfig(s: NonNullable<ReturnType<typeof getSession>>) {
  const packages = s.ikaClient.ikaConfig.packages as unknown as Record<string, unknown>;
  return Object.entries(packages)
    .filter(([, value]) => typeof value === 'string' && value.startsWith('0x'))
    .map(([label, id]) => ({ label, id: id as string }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function objectRefsFromIkaConfig(s: NonNullable<ReturnType<typeof getSession>>) {
  const objects = s.ikaClient.ikaConfig.objects as unknown as Record<string, unknown>;
  return Object.entries(objects)
    .flatMap(([label, value]) => {
      if (typeof value === 'string' && value.startsWith('0x')) return [{ label, id: value }];
      const objectId = (value as { objectID?: unknown } | undefined)?.objectID;
      return typeof objectId === 'string' && objectId.startsWith('0x') ? [{ label, id: objectId }] : [];
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function getChromaLabRefs(): Promise<ChromaLabRefs> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const settings = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  return {
    ikaBase: s.activeVaultBaseChain,
    networkIds: {
      sui: settings.suiNetworkId,
      solana: settings.solana.solNetworkId,
    },
    sui: {
      packageRefs: packageRefsFromIkaConfig(s),
      objectRefs: objectRefsFromIkaConfig(s),
      ikaCoinType: IKA_COIN_TYPE,
    },
    solana: {
      programRefs: [
        { label: 'ika pre-alpha program', id: SOLANA_PREALPHA_PROGRAM_ID },
      ],
      grpcUrl: SOLANA_PREALPHA_GRPC_URL,
    },
    encrypt: {
      programId: ENCRYPT_SOLANA_PROGRAM_ID,
      grpcUrl: ENCRYPT_SOLANA_GRPC_URL,
      rpcUrl: ENCRYPT_SOLANA_RPC_URL,
    },
  };
}

type ResolvedSuiDwallet = {
  dwalletId: string;
  curve: 'SECP256K1' | 'ED25519' | 'unknown';
  stateKind: string;
  chainAddresses?: DwalletCapChainAddresses;
  publicOutputB64?: string;
  encryptedShareId?: string;
};

async function resolveSuiDwallets(ids: string[]): Promise<Map<string, ResolvedSuiDwallet>> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const uniqueIds = [...new Set(ids)];
  const entries = await Promise.all(
    uniqueIds.map(async (dwalletId) => {
      try {
        const dwallet = await s.ikaClient.getDWallet(dwalletId) as {
          curve?: unknown;
          state?: { $kind?: string; Active?: { public_output?: number[] } };
          encrypted_user_secret_key_share_id?: { id?: string };
        };
        const curve = curveKeyFromDWallet(dwallet) ?? 'unknown';
        const stateKind = dwallet.state?.$kind ?? 'unknown';
        const publicOutput = dwallet.state?.Active?.public_output;
        const chainAddresses =
          curve !== 'unknown' && Array.isArray(publicOutput) && publicOutput.length > 0
            ? await deriveChainAddressesFromActivePublicOutput(curve, Uint8Array.from(publicOutput), 'mainnet').catch(() => undefined)
            : undefined;
        return [
          dwalletId,
          {
            dwalletId,
            curve,
            stateKind,
            chainAddresses,
            publicOutputB64: Array.isArray(publicOutput) && publicOutput.length > 0
              ? btoa(String.fromCharCode(...Uint8Array.from(publicOutput)))
              : undefined,
            encryptedShareId: dwallet.encrypted_user_secret_key_share_id?.id,
          } satisfies ResolvedSuiDwallet,
        ] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter(Boolean) as Array<readonly [string, ResolvedSuiDwallet]>);
}

function classifyTxSignal(createdDwalletIds: string[], dwalletIds: string[]): SuiExplorerTransactionRow['signal'] {
  if (dwalletIds.length === 0) return 'empty';
  const created = new Set(createdDwalletIds);
  let touchesNonCreated = false;
  for (const id of dwalletIds) {
    if (!created.has(id)) {
      touchesNonCreated = true;
      break;
    }
  }
  if (createdDwalletIds.length > 0 && touchesNonCreated) return 'mixed';
  if (createdDwalletIds.length > 0) return 'create';
  return 'event';
}

async function buildSuiSample(limit = SAMPLE_LIMIT_DEFAULT): Promise<SuiExplorerOverview> {
  const { client, coordinatorId } = await getSuiExplorerClient();
  const half = Math.max(12, Math.ceil(limit / 2));
  const [changedRows, fromRows] = await Promise.all([
    queryTransactionBlocksGraphQL(client, {
      // schema rename 2026-05: `changedObject` -> `affectedObject` on TransactionFilter.
      filter: { affectedObject: coordinatorId },
      limit: half,
      includeEvents: true,
    }),
    queryTransactionBlocksGraphQL(client, {
      filter: { sentAddress: coordinatorId },
      limit: half,
      includeEvents: true,
    }),
  ]);
  const mergedByDigest = new Map<string, SuiTxSummary>();
  for (const tx of changedRows) mergedByDigest.set(tx.digest, tx);
  for (const tx of fromRows) {
    if (!mergedByDigest.has(tx.digest)) mergedByDigest.set(tx.digest, tx);
  }
  const txsData = [...mergedByDigest.values()]
    .sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0))
    .slice(0, limit);

  const candidateIds = new Set<string>();
  for (const tx of txsData) {
    for (const id of tx.createdObjectIds) candidateIds.add(id);
    for (const id of idsFromEvents(tx.eventJsons)) candidateIds.add(id);
  }
  const resolved = await resolveSuiDwallets([...candidateIds]);
  const rowsById = new Map<string, ExplorerDwalletRow>();
  const recentTransactions: SuiExplorerTransactionRow[] = [];
  let successCount = 0;
  let failureCount = 0;

  for (const tx of txsData) {
    const status: 'success' | 'failure' = tx.status;
    if (status === 'success') successCount++;
    else failureCount++;
    const timestampMs = tx.timestampMs;
    const createdDwalletIds = tx.createdObjectIds.filter((id) => resolved.has(id));
    const dwalletIds = [...new Set([...idsFromEvents(tx.eventJsons), ...createdDwalletIds])].filter((id) => resolved.has(id));
    recentTransactions.push({
      digest: tx.digest,
      timestampMs,
      status,
      dwalletIds,
      createdDwalletIds,
      signal: classifyTxSignal(createdDwalletIds, dwalletIds),
    });

    for (const dwalletId of dwalletIds) {
      const detail = resolved.get(dwalletId)!;
      const existing = rowsById.get(dwalletId);
      const next: ExplorerDwalletRow = existing ?? {
        dwalletId,
        curve: detail.curve,
        stateKind: detail.stateKind,
        txCount: 0,
        lastSeenMs: null,
        lastSeenDigest: null,
        createdAtMs: null,
        createdDigest: null,
        chainAddresses: detail.chainAddresses,
      };
      next.txCount += 1;
      if (next.lastSeenMs == null || (timestampMs ?? 0) > (next.lastSeenMs ?? 0)) {
        next.lastSeenMs = timestampMs;
        next.lastSeenDigest = tx.digest;
      }
      if (createdDwalletIds.includes(dwalletId)) {
        if (next.createdAtMs == null || (timestampMs ?? 0) > (next.createdAtMs ?? 0)) {
          next.createdAtMs = timestampMs;
          next.createdDigest = tx.digest;
        }
      }
      rowsById.set(dwalletId, next);
    }
  }

  const allRows = [...rowsById.values()];
  const byCreated = [...allRows]
    .filter((row) => row.createdDigest)
    .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
    .slice(0, 8);
  const byTxCount = [...allRows]
    .sort((a, b) => b.txCount - a.txCount || (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0))
    .slice(0, 8);
  const byRecentTouch = [...allRows]
    .sort((a, b) => (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0))
    .slice(0, 8);
  const byAwaitingSignature = [...allRows]
    .filter((row) => row.stateKind === 'AwaitingKeyHolderSignature')
    .sort((a, b) => (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0))
    .slice(0, 8);
  return {
    sample: {
      coordinatorId,
      transactionCount: txsData.length,
      successCount,
      failureCount,
      sampledLimit: limit,
      mergeSources: ['ChangedObject', 'FromAddress'],
      fetchedRaw: changedRows.length + fromRows.length,
      dedupedTransactions: txsData.length,
    },
    heuristicSummary: {
      uniqueDwalletIds: rowsById.size,
      explain:
        'merged two graphql windows (coordinator as changed object + as sender), deduped by digest, then ranked dWallets inside that union. still not lifetime activity, just a wider slice than changed-object-only.',
    },
    lists: {
      mostRecentCreated: byCreated,
      mostActiveInSample: byTxCount,
      mostRecentlyTouched: byRecentTouch,
      awaitingSignature: byAwaitingSignature,
    },
    recentTransactions: recentTransactions.slice(0, 12),
  };
}

export async function getSuiExplorerOverview(limit = SAMPLE_LIMIT_DEFAULT): Promise<SuiExplorerOverview> {
  return buildSuiSample(limit);
}

export async function getSuiDwalletDetail(dwalletId: string): Promise<SuiDwalletDetail> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const dwallet = await s.ikaClient.getDWallet(dwalletId) as {
    curve?: unknown;
    state?: { $kind?: string; Active?: { public_output?: number[] } };
    encrypted_user_secret_key_share_id?: { id?: string };
  };
  const curve = curveKeyFromDWallet(dwallet) ?? 'unknown';
  const stateKind = dwallet.state?.$kind ?? 'unknown';
  const publicOutput = dwallet.state?.Active?.public_output;
  const chainAddresses =
    curve !== 'unknown' && Array.isArray(publicOutput) && publicOutput.length > 0
      ? await deriveChainAddressesFromActivePublicOutput(curve, Uint8Array.from(publicOutput), 'mainnet').catch(() => undefined)
      : undefined;
  const object = await s.suiClient.getObject({
    objectId: dwalletId,
    include: { previousTransaction: true, owner: true },
  });
  const ownedCaps = await listOwnedDWalletCapsForVault(s.activeVaultId).catch(() => []);
  const ownCap = ownedCaps.find((row) => row.dwalletId === dwalletId);
  const sample = await buildSuiSample(30);
  const owner = object.object.owner;
  const ownerType =
    typeof owner === 'string'
      ? owner
      : owner && typeof owner === 'object'
        ? Object.keys(owner)[0] ?? null
        : null;
  return {
    dwalletId,
    curve,
    stateKind,
    previousTransaction: object.object.previousTransaction ?? null,
    ownerType,
    chainAddresses,
    publicOutputB64: Array.isArray(publicOutput) && publicOutput.length > 0
      ? btoa(String.fromCharCode(...Uint8Array.from(publicOutput)))
      : undefined,
    encryptedShareId: dwallet.encrypted_user_secret_key_share_id?.id,
    isOwnedByActiveVault: Boolean(ownCap),
    activeVaultCapObjectId: ownCap?.capObjectId,
    recentTransactions: sample.recentTransactions.filter((tx) => tx.dwalletIds.includes(dwalletId)).slice(0, 12),
  };
}

export async function getSolanaProgramRecentOverview(limit = 12): Promise<SolanaProgramRecentOverview> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const settings = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  const conn = s.dwalletSolanaConnection ?? s.solanaConnection;
  if (!conn) {
    const rpcUrl = resolveSolanaRpcUrl(settings.solana);
    throw new Error(`Solana RPC not configured for explorer reads (${rpcUrl})`);
  }
  const signatures = await conn.getSignaturesForAddress(new PublicKey(SOLANA_PREALPHA_PROGRAM_ID), { limit });
  return {
    programId: SOLANA_PREALPHA_PROGRAM_ID,
    recentSignatures: signatures.map((sig) => ({
      signature: sig.signature,
      slot: sig.slot,
      blockTimeMs: sig.blockTime != null ? sig.blockTime * 1000 : null,
      status: sig.err === null ? 'success' : 'failure',
    })),
  };
}

export async function getSolanaDwalletDetail(dwalletId: string): Promise<SolanaDwalletDetail> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const settings = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  const conn = s.dwalletSolanaConnection ?? s.solanaConnection;
  if (!conn) {
    const rpcUrl = resolveSolanaRpcUrl(settings.solana);
    throw new Error(`Solana RPC not configured for explorer reads (${rpcUrl})`);
  }
  const account = await fetchSolanaDWalletAccount(conn, dwalletId);
  const info = await conn.getAccountInfo(new PublicKey(dwalletId));
  if (!info) throw new Error('Solana dWallet account not found');
  const signatures = await conn.getSignaturesForAddress(new PublicKey(dwalletId), { limit: 12 });
  return {
    dwalletId,
    curve: account.curveKey,
    publicOutputHex: toHex(account.publicOutput),
    chainAddresses: await chainAddressesForSolanaDwalletId(conn, dwalletId),
    lamports: info.lamports,
    executable: info.executable,
    ownerProgramId: info.owner.toBase58(),
    recentSignatures: signatures.map((sig) => ({
      signature: sig.signature,
      slot: sig.slot,
      blockTimeMs: sig.blockTime != null ? sig.blockTime * 1000 : null,
      status: sig.err === null ? 'success' : 'failure',
    })),
  };
}

// ---------------------------------------------------------------------------
// UnverifiedPresignCap sample
// ---------------------------------------------------------------------------
// network-wide hint of in-flight presign requests. these caps are produced
// when the coordinator hands back a presign session id but the network
// hasn't verified the output yet; once verified, the cap converts to a
// `VerifiedPresignCap`. high counts hint that the network is currently
// processing many presigns (or that someone has a lot queued).
//
// per `UnverifiedPresignCap` in `coordinator_inner` (ika sdk):
//   { id, dwallet_id: Option<bytes32>, presign_id: bytes32 }
// - dwallet_id is `Some` for dWallet-bound presigns (ECDSA), `None` for
//   global presigns (Schnorr / EdDSA).

export type UnverifiedPresignCapRow = {
  /** the UnverifiedPresignCap object id itself. */
  id: string;
  /** target dWallet, if the presign is bound to one (ECDSA). null for global presigns. */
  dwalletId: string | null;
  /** the in-flight presign session id this cap controls. */
  presignId: string | null;
};

export type UnverifiedPresignCapSample = {
  /** total caps observed in this sample window. capped by `maxPages * 50`. */
  observed: number;
  /** true if we hit the page cap before the network ran out of caps - real total is unknown. */
  truncated: boolean;
  /** most recent caps in the sample, ordered by GraphQL response order. */
  recent: UnverifiedPresignCapRow[];
  /** fully qualified Move type we queried (uses the original package, which is the canonical name). */
  capType: string;
  /** direct link to suiscan's collection-items view for this type. empty string if non-mainnet. */
  suiscanCollectionUrl: string;
};

function extractOptionalIdField(json: unknown, key: string): string | null {
  if (!json || typeof json !== 'object') return null;
  const v = (json as Record<string, unknown>)[key];
  // BCS `Option<bytes32>` deserializes as either the bare id string or `{ id: '0x...' }` /
  // `{ vec: ['0x...'] }` depending on the field schema. accept all three shapes.
  if (typeof v === 'string' && v.startsWith('0x')) return v;
  if (v && typeof v === 'object') {
    const inner = (v as { id?: unknown }).id;
    if (typeof inner === 'string' && inner.startsWith('0x')) return inner;
    const vec = (v as { vec?: unknown }).vec;
    if (Array.isArray(vec) && typeof vec[0] === 'string' && (vec[0] as string).startsWith('0x')) {
      return vec[0] as string;
    }
  }
  return null;
}

function extractRequiredIdField(json: unknown, key: string): string | null {
  if (!json || typeof json !== 'object') return null;
  const v = (json as Record<string, unknown>)[key];
  if (typeof v === 'string' && v.startsWith('0x')) return v;
  if (v && typeof v === 'object') {
    const inner = (v as { id?: unknown }).id;
    if (typeof inner === 'string' && inner.startsWith('0x')) return inner;
  }
  return null;
}

/**
 * walk one or more pages of `UnverifiedPresignCap` objects on Sui and return a sample.
 *
 * defaults to 2 pages (100 caps) - enough to give a sense of the in-flight queue without
 * pinning the SW on a long walk. raise the limit if a caller wants exhaustive enumeration.
 */
export async function getUnverifiedPresignCapSample(
  opts: { recentLimit?: number; maxPages?: number } = {},
): Promise<UnverifiedPresignCapSample> {
  const recentLimit = opts.recentLimit ?? 5;
  const maxPages = opts.maxPages ?? 2;

  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const { networkId, client } = await getSuiExplorerClient();

  // use the original package because that's where the type's identity lives. an upgrade
  // can replace the current package address; the type's canonical name still resolves via
  // `ikaDwallet2pcMpcOriginalPackage`.
  const originalPkg = s.ikaClient.ikaConfig.packages.ikaDwallet2pcMpcOriginalPackage;
  const capType = `${originalPkg}::coordinator_inner::UnverifiedPresignCap`;

  let observed = 0;
  const recent: UnverifiedPresignCapRow[] = [];
  let cursor: string | null = null;
  let truncated = false;
  for (let i = 0; i < maxPages; i++) {
    const page = await queryObjectsByTypeGraphQL(client, {
      filter: { type: capType },
      first: 50,
      after: cursor,
    });
    observed += page.nodes.length;
    for (const node of page.nodes) {
      if (recent.length < recentLimit) {
        recent.push({
          id: node.address,
          dwalletId: extractOptionalIdField(node.json, 'dwallet_id'),
          presignId: extractRequiredIdField(node.json, 'presign_id'),
        });
      }
    }
    if (!page.hasNextPage) break;
    cursor = page.endCursor;
    if (i === maxPages - 1) truncated = true;
  }

  // suiscan collection items url. only emitted for sui-mainnet because suiscan doesn't host
  // collection-by-type pages on testnet/devnet; the UI falls back to a plain type label when
  // this is empty.
  const suiscanCollectionUrl =
    networkId === 'sui-mainnet'
      ? `https://suiscan.xyz/mainnet/collection/${capType}/items`
      : '';

  return { observed, truncated, recent, capType, suiscanCollectionUrl };
}
