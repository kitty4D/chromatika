import type { IkaConfig } from '@ika.xyz/sdk';
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { normalizeStructTag } from '@mysten/sui/utils';
import type { SessionState } from '@/background/session';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';

const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

const MIN_SPLIT_AMOUNT_MIST = 500_000_000n; // 0.5 SUI - enough for several ika protocol splits

export function ikaCoinType(config: IkaConfig): string {
  return `${config.packages.ikaPackage}::ika::IKA`;
}

/** normalized `Coin<T>` struct tag for an inner type like `0x2::sui::SUI`. */
function normalizedWrappedCoinType(innerCoinType: string): string {
  return normalizeStructTag(`0x2::coin::Coin<${innerCoinType}>`);
}

/** list all SUI coin objects owned by `owner`, filtering to correct struct tag. */
async function listSuiCoins(
  client: SuiGraphQLClient,
  owner: string,
): Promise<{ id: string; balance: bigint }[]> {
  const want = normalizedWrappedCoinType(SUI_TYPE);
  const coins: { id: string; balance: bigint }[] = [];
  let cursor: string | null = null;
  for (;;) {
    const res = await client.listCoins({
      owner,
      coinType: SUI_TYPE,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    for (const o of res.objects) {
      if (normalizeStructTag(o.type) === want) {
        coins.push({ id: o.objectId, balance: BigInt(o.balance ?? '0') });
      }
    }
    if (!res.hasNextPage) break;
    cursor = res.cursor;
  }
  return coins;
}

/**
 * split the gas coin into two so ika PTBs can use one for protocol fees
 * and the network can pay gas from the other.
 *
 * uses `tx.gas` (not `tx.object(coin.id)`) because when there's only one SUI coin,
 * using it as an explicit PTB input prevents the gas resolver from also using it
 * for gas payment. `tx.gas` is the Sui runtime's special reference that lets the
 * gas coin serve both roles.
 */
async function autoSplitSuiCoin(
  session: SessionState,
  splitAmountMist: bigint,
): Promise<void> {
  const tx = new Transaction();
  const split = tx.splitCoins(tx.gas, [splitAmountMist]);
  tx.transferObjects([split[0]], getSuiFeePayerSuiAddress(session));
  const { executeSuiTransaction } = await import('@/background/sui/execute-transaction');
  const result = await executeSuiTransaction(session, tx, { include: { effects: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    throw new Error(`Auto-split SUI coin failed: ${typeof err === 'string' ? err : JSON.stringify(err)}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

/**
 * Mysten's gas resolver cannot use a SUI coin object as gas payment if that same object is a PTB
 * input (e.g. `splitCoins(tx.object(suiCoinId), …)`). so ika PTBs need **another** SUI coin (or
 * enough balance across other coins) to cover network gas while one coin supplies the ika protocol
 * split. pick the **smallest** coin that still covers `minProtocolSplitMist` so larger coins stay
 * available for gas selection.
 *
 * when only one SUI coin object exists and a `session` is provided, the function automatically
 * splits it into two (send-to-self) and retries, removing the manual step.
 */
export async function pickSuiCoinForIkaProtocolSplit(
  client: SuiGraphQLClient,
  owner: string,
  minProtocolSplitMist: bigint,
  /** cover typical simulate budgets (~0.15 SUI) with headroom. */
  minMistInOtherCoinsForGas: bigint = 200_000_000n,
  /** when set, auto-splits a single SUI coin instead of throwing. */
  session?: SessionState,
): Promise<string> {
  let coins = await listSuiCoins(client, owner);
  if (coins.length === 0) throw new Error('No SUI coins for gas. Fund this address on the active Sui network.');

  const suiStr = (m: bigint) => `${(Number(m) / 1e9).toFixed(4)} SUI`;

  if (coins.length === 1) {
    const only = coins[0];
    const neededForSplit = minProtocolSplitMist + minMistInOtherCoinsForGas;
    if (only.balance < neededForSplit) {
      throw new Error(
        `Single SUI coin (${suiStr(only.balance)}) is too small to auto-split: need at least ${suiStr(neededForSplit)} to cover ika protocol fees + gas. Fund this fee address with more SUI.`,
      );
    }
    if (!session) {
      throw new Error(
        `Ika transactions need at least two SUI coin objects on your fee address: one is used as an input for ika protocol fees, and the network must pay gas from a different coin. You only have one SUI coin (${suiStr(only.balance)}). Send a small amount of SUI to yourself once to create a second coin object, then retry.`,
      );
    }
    const splitAmount =
      only.balance > MIN_SPLIT_AMOUNT_MIST * 2n
        ? MIN_SPLIT_AMOUNT_MIST
        : only.balance / 2n;
    await autoSplitSuiCoin(session, splitAmount);
    coins = await listSuiCoins(client, owner);
    if (coins.length < 2) {
      throw new Error(
        'Auto-split tx succeeded but indexer still shows one coin. Wait a few seconds and retry.',
      );
    }
  }

  coins.sort((a, b) => (a.balance < b.balance ? -1 : a.balance > b.balance ? 1 : 0));

  for (const c of coins) {
    if (c.balance < minProtocolSplitMist) continue;
    const otherTotal = coins.filter((x) => x.id !== c.id).reduce((a, x) => a + x.balance, 0n);
    if (otherTotal >= minMistInOtherCoinsForGas) return c.id;
  }

  throw new Error(
    `Cannot pick SUI for ika splits plus gas: need one coin with at least ${suiStr(minProtocolSplitMist)} for ika, and other coins totaling at least ${suiStr(minMistInOtherCoinsForGas)} for network gas (fee address may have one large coin — send part to yourself to split).`,
  );
}

export async function pickCoinObjectId(
  client: SuiGraphQLClient,
  owner: string,
  coinType: string,
): Promise<string | null> {
  const want = normalizedWrappedCoinType(coinType);
  let cursor: string | null = null;
  for (;;) {
    const res = await client.listCoins({
      owner,
      coinType,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    for (const o of res.objects) {
      if (normalizeStructTag(o.type) === want) {
        return o.objectId;
      }
    }
    if (!res.hasNextPage) break;
    cursor = res.cursor;
  }
  return null;
}

export async function requireSuiAndIkaCoins(
  client: SuiGraphQLClient,
  ikaConfig: IkaConfig,
  owner: string,
  opts?: {
    /** when set, chooses a SUI coin for ika `splitCoins` that leaves other SUI coins for network gas. */
    minSuiProtocolSplitMist: bigint;
    /** when set, auto-splits a single SUI coin instead of throwing. */
    session?: SessionState;
  },
): Promise<{ suiCoinId: string; ikaCoinId: string; ikaType: string }> {
  const ikaType = ikaCoinType(ikaConfig);
  const [suiCoinId, ikaCoinId] = await Promise.all([
    opts?.minSuiProtocolSplitMist !== undefined
      ? pickSuiCoinForIkaProtocolSplit(client, owner, opts.minSuiProtocolSplitMist, undefined, opts.session)
      : pickCoinObjectId(client, owner, SUI_TYPE),
    pickCoinObjectId(client, owner, ikaType),
  ]);
  if (!suiCoinId) throw new Error('No SUI coins for gas. Fund this address on the active Sui network.');
  if (!ikaCoinId) throw new Error('No IKA for protocol fees. Acquire IKA for this network.');
  return { suiCoinId, ikaCoinId, ikaType };
}

/** whether ika txs can pay gas + protocol splits (coin objects exist). */
export async function getFundingReadiness(
  client: SuiGraphQLClient,
  ikaConfig: IkaConfig,
  owner: string,
): Promise<{ ready: boolean; missing: ('sui' | 'ika')[] }> {
  const ikaType = ikaCoinType(ikaConfig);
  const [suiCoinId, ikaCoinId] = await Promise.all([
    pickCoinObjectId(client, owner, SUI_TYPE),
    pickCoinObjectId(client, owner, ikaType),
  ]);
  const missing: ('sui' | 'ika')[] = [];
  if (!suiCoinId) missing.push('sui');
  if (!ikaCoinId) missing.push('ika');
  return { ready: missing.length === 0, missing };
}

/**
 * total SUI balance in MIST (base units, 9 decimals).
 * sums all SUI coin objects for the given owner.
 */
export async function getSuiBalanceMist(
  client: SuiGraphQLClient,
  owner: string,
): Promise<bigint> {
  const want = normalizedWrappedCoinType(SUI_TYPE);
  let total = 0n;
  let cursor: string | null = null;
  for (;;) {
    const res = await client.listCoins({
      owner,
      coinType: SUI_TYPE,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    for (const o of res.objects) {
      if (normalizeStructTag(o.type) === want) {
        total += BigInt(o.balance ?? '0');
      }
    }
    if (!res.hasNextPage) break;
    cursor = res.cursor;
  }
  return total;
}

/**
 * total IKA balance in base units. sums all IKA coin objects for the given owner.
 */
export async function getIkaBalanceBaseUnits(
  client: SuiGraphQLClient,
  ikaConfig: IkaConfig,
  owner: string,
): Promise<bigint> {
  const ikaType = ikaCoinType(ikaConfig);
  const want = normalizedWrappedCoinType(ikaType);
  let total = 0n;
  let cursor: string | null = null;
  for (;;) {
    const res = await client.listCoins({
      owner,
      coinType: ikaType,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    for (const o of res.objects) {
      if (normalizeStructTag(o.type) === want) {
        total += BigInt(o.balance ?? '0');
      }
    }
    if (!res.hasNextPage) break;
    cursor = res.cursor;
  }
  return total;
}

export { SUI_TYPE };
