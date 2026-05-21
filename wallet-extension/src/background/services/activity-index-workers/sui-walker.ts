/**
 * Sui activity-index worker. Paginates `transactions(filter: { sentAddress })` via the
 * vault's `SuiGraphQLClient` and records one indexed-tx row per outbound tx.
 *
 * counterparty extraction (best-effort):
 *   - we ask for `balanceChanges` per tx along with the standard fields.
 *   - the recipient = the address in `balanceChanges` with the largest positive `amount`
 *     that isn't the sender. for a vanilla `transferObjects` PTB this lands on the right
 *     address; for complex PTBs with multiple recipients we pick the largest receiver,
 *     which is a defensible heuristic for the first-time-recipient check.
 *   - rows where we can't extract a clear recipient store `counterparty: null` and won't
 *     contribute to the first-time-recipient lookup (graceful degradation).
 *
 * coverage ceiling: `'complete-to-genesis'`. Mysten GraphQL paginates `transactions` all
 * the way to genesis (no upstream-imposed retention horizon). When `pageInfo.hasNextPage`
 * is false, the walker is genuinely done for this address.
 */

import {
  createSuiGraphQLClientFromRegistryNetworkId,
  type SuiTxBlocksFilter,
} from '@/background/sui-client';
import { getSession } from '@/background/session';
import { getDwalletNetworkSettings } from '@/background/network/tier-network-settings';
import type { IndexWalker } from '@/background/services/activity-index-orchestrator';
import { makeTxKey, type IndexedTx } from '@/background/services/activity-index';
import { classifySuiTx } from '@/background/services/activity-classifier/sui-classifier';
import { PriceCache } from './price-cache';

const PAGE_SIZE = 50;

const TX_QUERY = /* GraphQL */ `
  query ChromatikaSuiActivityIndex(
    $filter: TransactionFilter
    $first: Int
    $after: String
  ) {
    transactions(filter: $filter, first: $first, after: $after) {
      nodes {
        digest
        kind {
          __typename
          ... on ProgrammableTransactionBlock {
            commands(first: 20) {
              nodes {
                __typename
                ... on MoveCall {
                  package
                  module
                  functionName
                }
              }
            }
          }
        }
        sender { address }
        effects {
          timestamp
          status
          checkpoint { sequenceNumber }
          balanceChanges(first: 30) {
            nodes {
              owner { address }
              amount
              coinType { repr }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

type CommandNode = {
  __typename?: string | null;
  package?: string | null;
  module?: string | null;
  functionName?: string | null;
};

type Node = {
  digest: string;
  kind?: {
    __typename?: string | null;
    commands?: {
      nodes?: CommandNode[] | null;
    } | null;
  } | null;
  sender?: { address?: string | null } | null;
  effects?: {
    timestamp?: string | null;
    status?: string | null;
    checkpoint?: { sequenceNumber?: number | string | null } | null;
    balanceChanges?: {
      nodes?: Array<{
        owner?: { address?: string | null } | null;
        amount?: string | number | null;
        coinType?: { repr?: string | null } | null;
      }> | null;
    } | null;
  } | null;
};

type Resp = {
  data?: {
    transactions?: {
      nodes?: Node[] | null;
      pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
};

/** parse timestamp (ISO string or epoch-ms string) into a number. returns null on failure. */
function parseTimestampMs(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** pick the most likely recipient from `balanceChanges`: largest positive amount whose
 * owner isn't the sender. ties broken by first-seen. returns null on PTBs we can't
 * confidently attribute (no positive balance change to anyone other than the sender). */
type BalanceChangeNode = {
  owner?: { address?: string | null } | null;
  amount?: string | number | null;
  coinType?: { repr?: string | null } | null;
};

function extractRecipient(
  changes: BalanceChangeNode[],
  sender: string | null,
): { recipient: string | null; primaryAmount: bigint | null; primaryCoinType: string | null } {
  let bestRecipient: string | null = null;
  let bestAmount: bigint = 0n;
  let bestCoinType: string | null = null;
  const senderLc = sender?.toLowerCase() ?? null;
  for (const n of changes ?? []) {
    const owner = n?.owner?.address ?? null;
    if (!owner) continue;
    if (senderLc && owner.toLowerCase() === senderLc) continue;
    const raw = n?.amount;
    if (raw == null) continue;
    let amt: bigint;
    try {
      amt = BigInt(typeof raw === 'number' ? Math.trunc(raw) : raw);
    } catch {
      continue;
    }
    if (amt <= 0n) continue;
    if (amt > bestAmount) {
      bestAmount = amt;
      bestRecipient = owner;
      bestCoinType = n?.coinType?.repr ?? null;
    }
  }
  return {
    recipient: bestRecipient,
    primaryAmount: bestRecipient ? bestAmount : null,
    primaryCoinType: bestCoinType,
  };
}

/** map a Sui coinType repr (`0xPKG::module::COIN`) to a short symbol. for the well-known
 * coins this is `SUI` / `IKA`; everything else falls through to the last path segment. */
function coinTypeToSymbol(repr: string | null): string | null {
  if (!repr) return null;
  if (repr === '0x2::sui::SUI' || repr.endsWith('::sui::SUI')) return 'SUI';
  if (repr.endsWith('::ika::IKA')) return 'IKA';
  const tail = repr.split('::').pop();
  return tail ?? null;
}

export const suiActivityIndexWalker: IndexWalker = {
  chain: 'sui',
  source: 'mysten-graphql',
  coverageCeiling: 'complete-to-genesis',

  async fetchPage({ vaultId, address, cursor }) {
    const s = getSession();
    if (!s) throw new Error('Wallet locked');
    const dw = await getDwalletNetworkSettings(s.activeVaultId, {
      network: s.network,
      baseChain: s.activeVaultBaseChain,
    });
    const client = createSuiGraphQLClientFromRegistryNetworkId(dw.suiNetworkId);

    const filter: SuiTxBlocksFilter = { sentAddress: address };
    const res = (await (
      client as unknown as {
        query: (opts: {
          query: string;
          variables: Record<string, unknown>;
        }) => Promise<Resp>;
      }
    ).query({
      query: TX_QUERY,
      variables: {
        filter,
        first: PAGE_SIZE,
        after: cursor,
      },
    })) as Resp;

    if (res.errors?.length) {
      const msg = res.errors.map((e) => e?.message).filter(Boolean).join('; ');
      throw new Error(`Sui GraphQL transactions: ${msg}`);
    }

    const nodes = res.data?.transactions?.nodes ?? [];
    const pageInfo = res.data?.transactions?.pageInfo ?? null;
    const rows: IndexedTx[] = [];
    let newest: string | null = null;
    let oldest: string | null = null;
    const priceCache = new PriceCache();

    for (const node of nodes) {
      const digest = node.digest;
      if (!digest) continue;
      const sender = node.sender?.address ?? null;
      const ts = parseTimestampMs(node.effects?.timestamp);
      // position: prefer checkpoint sequenceNumber; fall back to timestampMs string.
      const cp = node.effects?.checkpoint?.sequenceNumber ?? null;
      const position =
        cp != null
          ? String(cp)
          : ts != null
            ? String(ts)
            : '0';

      const { recipient, primaryAmount, primaryCoinType } = extractRecipient(
        node.effects?.balanceChanges?.nodes ?? [],
        sender,
      );

      // extract move-call summaries from the PTB commands (Gap 2). MoveCall nodes only
      // appear when `kind.__typename === 'ProgrammableTransactionBlock'`; non-PTBs (rare
      // legacy paths) leave moveCalls empty and the classifier defaults to 'transfer'.
      const moveCalls = (node.kind?.commands?.nodes ?? [])
        .filter((cmd) => cmd?.__typename === 'MoveCall')
        .map((cmd) => ({
          package: cmd.package ?? null,
          module: cmd.module ?? null,
          functionName: cmd.functionName ?? null,
        }));

      // counterparty lower-case for Sui (case-insensitive hex).
      const counterparty = recipient ? recipient.toLowerCase() : null;
      const base: IndexedTx = {
        key: makeTxKey('sui', vaultId, digest),
        vaultId,
        chain: 'sui',
        digest,
        perspectiveAddress: address.toLowerCase(),
        counterparty,
        position,
        timestampMs: ts,
        symbol: coinTypeToSymbol(primaryCoinType),
        amountRaw: primaryAmount != null ? primaryAmount.toString() : null,
        source: 'mysten-graphql',
        status: 'success',
      };
      const classified = classifySuiTx(base, { moveCalls });
      // sui native coin types: SUI (9 decimals) and IKA (9 decimals). other coins fall
      // through to the priceCache's symbol lookup which only succeeds for symbols in the
      // upstream price source - obscure coins land as null and the UI shows no USD.
      const decimals = base.symbol === 'SUI' || base.symbol === 'IKA' ? 9 : 9;
      const priceUsdAtSync = await priceCache.usdValueFor(base.symbol, base.amountRaw, decimals);
      rows.push({
        ...base,
        kind: classified.kind,
        swapMeta: classified.swapMeta,
        priceUsdAtSync,
      });

      if (newest === null || BigInt(position) > BigInt(newest)) newest = position;
      if (oldest === null || BigInt(position) < BigInt(oldest)) oldest = position;
    }

    const nextCursor = pageInfo?.hasNextPage ? (pageInfo.endCursor ?? null) : null;
    return {
      rows,
      nextCursor,
      newestPosition: newest,
      oldestPosition: oldest,
    };
  },
};
