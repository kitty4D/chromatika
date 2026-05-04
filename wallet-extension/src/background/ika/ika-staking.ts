import { systemTransactions } from '@ika.xyz/sdk';
import { Transaction, Inputs } from '@mysten/sui/transactions';
import { getSession, type SessionState } from '@/background/session';
import { ikaCoinType } from '@/background/ika/coins';
import { executeSuiTransaction } from '@/background/sui/execute-transaction';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';
import { dryRunSuiTransaction } from '@/background/sui/sui-simulation';
import { normalizeStructTag } from '@mysten/sui/utils';

export type IkaValidatorRow = {
  objectId: string;
  validatorId: string;
  name: string;
};

export type StakedIkaPosition = {
  objectId: string;
  /** best-effort from object json */
  validatorId?: string;
  principalBaseUnits?: string;
};

function assertSuiBaseIkaSession(s: SessionState): void {
  if (s.activeVaultBaseChain === 'solana') {
    throw new Error('IKA staking runs on Sui. Use a Sui-base dWallet vault for this flow.');
  }
}

function systemObjectInput(tx: Transaction, session: SessionState) {
  const o = session.ikaClient.ikaConfig.objects.ikaSystemObject;
  return tx.object(
    Inputs.SharedObjectRef({
      objectId: o.objectID,
      initialSharedVersion: o.initialSharedVersion,
      mutable: true,
    }),
  );
}

async function listCoinsOfType(
  session: SessionState,
  owner: string,
  coinType: string,
): Promise<{ id: string; balance: bigint }[]> {
  const want = normalizeStructTag(`0x2::coin::Coin<${coinType}>`);
  const out: { id: string; balance: bigint }[] = [];
  let cursor: string | null = null;
  for (;;) {
    const res = await session.suiClient.listCoins({
      owner,
      coinType,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    for (const o of res.objects) {
      if (normalizeStructTag(o.type) === want) {
        out.push({ id: o.objectId, balance: BigInt(o.balance ?? '0') });
      }
    }
    if (!res.hasNextPage) break;
    cursor = res.cursor;
  }
  return out;
}

/**
 * best-effort validator discovery via GraphQL `objects` filter.
 * often empty depending on RPC; the staking UI also accepts a pasted validator object id.
 */
export async function listIkaValidatorsForSession(): Promise<IkaValidatorRow[]> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  assertSuiBaseIkaSession(s);
  const pkg = s.ikaClient.ikaConfig.packages.ikaSystemOriginalPackage;
  const type = `${pkg}::validator::Validator`;
  try {
    const res = await s.suiClient.query<{
      objects?: {
        nodes?: Array<{
          address?: string;
          asObject?: { json?: Record<string, unknown> | null } | null;
        }>;
      };
    }>({
      query: `query IkaValidators($type: String!) {
        objects(filter: { type: $type }, first: 50) {
          nodes { address asObject { json } }
        }
      }`,
      variables: { type },
    });
    const nodes = res.data?.objects?.nodes ?? [];
    const rows: IkaValidatorRow[] = [];
    for (const n of nodes) {
      const addr = n.address;
      if (!addr) continue;
      const j = n.asObject?.json ?? {};
      const name =
        typeof j.name === 'string'
          ? j.name
          : typeof (j.metadata as Record<string, unknown> | undefined)?.name === 'string'
            ? String((j.metadata as { name: string }).name)
            : addr.slice(0, 12);
      rows.push({ objectId: addr, validatorId: addr, name });
    }
    return rows;
  } catch {
    return [];
  }
}

/** `StakedIka` objects owned by the fee payer (IKA stake lives with the same owner as portfolio IKA balance). */
export async function listStakedIkaForSession(): Promise<StakedIkaPosition[]> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  assertSuiBaseIkaSession(s);
  const owner = getSuiFeePayerSuiAddress(s);
  const pkg = s.ikaClient.ikaConfig.packages.ikaSystemOriginalPackage;
  const type = `${pkg}::staked_ika::StakedIka`;
  const out: StakedIkaPosition[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: {
      objects: Array<{ objectId: string; json: Record<string, unknown> | null }>;
      hasNextPage: boolean;
      cursor: string | null;
    } = await s.suiClient.listOwnedObjects({
      owner,
      type,
      cursor,
      limit: 50,
      include: { json: true },
    });
    for (const o of page.objects) {
      const j = o.json ?? {};
      const validatorId =
        typeof j.validator_id === 'string'
          ? j.validator_id
          : typeof (j as { validator?: { id?: string } }).validator?.id === 'string'
            ? (j as { validator: { id: string } }).validator.id
            : undefined;
      const principal =
        typeof j.principal === 'string' || typeof j.principal === 'number'
          ? String(j.principal)
          : typeof (j as { staked_amount?: string }).staked_amount === 'string'
            ? (j as { staked_amount: string }).staked_amount
            : undefined;
      out.push({ objectId: o.objectId, validatorId, principalBaseUnits: principal });
    }
    if (!page.hasNextPage || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

export async function buildAndExecuteAddStake(params: {
  validatorId: string;
  amountBaseUnits: bigint;
}): Promise<void> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  assertSuiBaseIkaSession(s);
  const owner = getSuiFeePayerSuiAddress(s);
  const cfg = s.ikaClient.ikaConfig;
  const ikaType = ikaCoinType(cfg);
  const coins = await listCoinsOfType(s, owner, ikaType);
  if (coins.length === 0) throw new Error('No IKA coins on your fee address to stake.');
  coins.sort((a, b) => (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0));

  const tx = new Transaction();
  const systemRef = systemObjectInput(tx, s);

  const primary = tx.object(coins[0]!.id);
  for (let i = 1; i < coins.length; i++) {
    tx.mergeCoins(primary, [tx.object(coins[i]!.id)]);
  }

  const total = coins.reduce((a, c) => a + c.balance, 0n);
  if (total < params.amountBaseUnits) throw new Error('IKA balance too low for this stake amount.');
  const stakeCoin = tx.splitCoins(primary, [params.amountBaseUnits])[0];
  const staked = systemTransactions.requestAddStake(cfg, systemRef, stakeCoin, params.validatorId, tx);
  tx.transferObjects([staked], owner);

  const result = await executeSuiTransaction(s, tx, { include: { effects: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }
}

async function tryDryRunWithdraw(
  s: SessionState,
  build: (tx: Transaction) => void,
): Promise<boolean> {
  const tx = new Transaction();
  build(tx);
  const dry = await dryRunSuiTransaction(s, tx, { checksEnabled: true });
  return dry.ok;
}

export async function buildAndExecuteWithdrawStake(stakedIkaObjectId: string): Promise<void> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  assertSuiBaseIkaSession(s);
  const owner = getSuiFeePayerSuiAddress(s);
  const cfg = s.ikaClient.ikaConfig;

  const useDirectWithdraw = await tryDryRunWithdraw(s, (tx) => {
    const systemRef = systemObjectInput(tx, s);
    const coin = systemTransactions.withdrawStake(cfg, systemRef, stakedIkaObjectId, tx);
    tx.transferObjects([coin], owner);
  });

  const tx = new Transaction();
  const systemRef = systemObjectInput(tx, s);
  if (useDirectWithdraw) {
    const coin = systemTransactions.withdrawStake(cfg, systemRef, stakedIkaObjectId, tx);
    tx.transferObjects([coin], owner);
  } else {
    systemTransactions.requestWithdrawStake(cfg, systemRef, stakedIkaObjectId, tx);
  }

  const result = await executeSuiTransaction(s, tx, { include: { effects: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }
}
