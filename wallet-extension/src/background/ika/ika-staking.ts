import { systemTransactions } from '@ika.xyz/sdk';
import { Transaction, Inputs } from '@mysten/sui/transactions';
import { getSession, type SessionState } from '@/background/session';
import { ikaCoinType } from '@/background/ika/coins';
import { executeSuiTransaction } from '@/background/sui/execute-transaction';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';
import { dryRunSuiTransaction } from '@/background/sui/sui-simulation';
import { normalizeStructTag } from '@mysten/sui/utils';
import { beginOperation } from '@/background/progress/operation-progress';

export type IkaValidatorStatus = 'PreActive' | 'Active' | 'Withdrawing' | 'Unknown';

export type IkaValidatorRow = {
  objectId: string;
  validatorId: string;
  name: string;
  status: IkaValidatorStatus;
  /** total bonded stake on this validator, base units (9 decimals on mainnet). */
  totalStakeBaseUnits: string;
  /** validator commission in basis points (1000 = 10.0%). */
  commissionRateBps: number;
  /** epoch the validator first activated; null if still PreActive. */
  activationEpoch: number | null;
  /** last epoch this validator was updated/processed. */
  latestEpoch: number | null;
  /** accumulated rewards pool held by the validator (commission + stakers). */
  rewardsPoolBaseUnits: string;
  /** accumulated commission earnings still held by the validator. */
  commissionBaseUnits: string;
  /** total validator shares outstanding. */
  numShares: string;
  /** optional p2p network address; surfaced on the validator detail card only. */
  networkAddress?: string;
};

export type StakedIkaPosition = {
  objectId: string;
  /** best-effort from object json */
  validatorId?: string;
  principalBaseUnits?: string;
  /** epoch the stake became active, if exposed in the object json. */
  activationEpoch?: number;
};

/**
 * cheap epoch + global-rewards snapshot for the staking screen header and APY math.
 * pulled from the Ika system inner via `IkaClient.ensureInitialized()`, which the SDK already
 * caches; we call `invalidateObjectCache()` first when callers want a fresh read.
 */
export type IkaSystemSnapshot = {
  epoch: number;
  epochStartTimestampMs: number;
  epochDurationMs: number;
  protocolVersion: number;
  /** total bonded IKA across all validators (base units). */
  totalStakeBaseUnits: string;
  /** per-epoch IKA subsidy distributed by the protocol treasury (base units). */
  stakeSubsidyAmountPerDistributionBaseUnits: string;
  /** active set size, used as the equal-share denominator for APY math. */
  activeValidatorCount: number;
  /** millis since epoch when this snapshot was fetched. */
  fetchedAtMs: number;
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

function parseValidatorStatus(state: unknown): IkaValidatorStatus {
  // Sui GraphQL exposes enum variants as `{ "@variant": "Active", ... }`; BCS-parsed values
  // use `$kind`; some older shapes encode the variant as a key on a record. Accept all three.
  if (typeof state === 'string') {
    if (state === 'Active' || state === 'PreActive' || state === 'Withdrawing') return state;
    return 'Unknown';
  }
  if (state && typeof state === 'object') {
    const obj = state as Record<string, unknown>;
    const variant = typeof obj['@variant'] === 'string' ? (obj['@variant'] as string) : undefined;
    if (variant === 'Active' || variant === 'PreActive' || variant === 'Withdrawing') return variant;
    const kind = typeof obj.$kind === 'string' ? obj.$kind : undefined;
    if (kind === 'Active' || kind === 'PreActive' || kind === 'Withdrawing') return kind;
    if ('Active' in obj) return 'Active';
    if ('PreActive' in obj) return 'PreActive';
    if ('Withdrawing' in obj) return 'Withdrawing';
  }
  return 'Unknown';
}

function toBigIntStr(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return v.toString();
  return '0';
}

function toIntOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && /^\d+$/.test(v.trim())) {
    const n = Number.parseInt(v.trim(), 10);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * read every validator object via GraphQL `objects` filter. parses the full on-chain
 * `Validator` shape (id, validator_info, state, ika_balance, commission_rate, ...) so the
 * staking screen can render names, commission, ~APY, total stake, and status without a
 * third-party backend. matches the field layout shown in [`ika_system/validator.d.ts`].
 *
 * Note on GraphQL shape: the Sui GraphQL endpoint exposes the Move-object payload at
 * `asMoveObject.contents.json` (NOT `asObject.json`, which was the original query and is
 * why this list "often came back empty" before the fix - the old field name didn't exist
 * on the new schema so the whole request validation failed silently for the caller).
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
          asMoveObject?: { contents?: { json?: Record<string, unknown> | null } | null } | null;
        }>;
      };
    }>({
      query: `query IkaValidators($type: String!) {
        objects(filter: { type: $type }, first: 50) {
          nodes { address asMoveObject { contents { json } } }
        }
      }`,
      variables: { type },
    });
    const nodes = res.data?.objects?.nodes ?? [];
    const rows: IkaValidatorRow[] = [];
    for (const n of nodes) {
      const addr = n.address;
      if (!addr) continue;
      const j = (n.asMoveObject?.contents?.json ?? {}) as Record<string, unknown>;
      const info = (j.validator_info ?? {}) as Record<string, unknown>;
      const rewardsPool = (j.rewards_pool ?? {}) as { value?: unknown };
      const commission = (j.commission ?? {}) as { value?: unknown };
      const name =
        typeof info.name === 'string' && info.name.length > 0
          ? info.name
          : typeof (j as { name?: string }).name === 'string'
            ? String((j as { name: string }).name)
            : addr.slice(0, 12);
      const status = parseValidatorStatus(j.state);
      const commissionRateRaw = typeof j.commission_rate === 'number' ? j.commission_rate : toIntOrNull(j.commission_rate);
      rows.push({
        objectId: addr,
        validatorId: addr,
        name,
        status,
        totalStakeBaseUnits: toBigIntStr(j.ika_balance),
        commissionRateBps: commissionRateRaw ?? 0,
        activationEpoch: toIntOrNull(j.activation_epoch),
        latestEpoch: toIntOrNull(j.latest_epoch),
        rewardsPoolBaseUnits: toBigIntStr(rewardsPool?.value),
        commissionBaseUnits: toBigIntStr(commission?.value),
        numShares: toBigIntStr(j.num_shares),
        ...(typeof info.network_address === 'string' && info.network_address.length > 0
          ? { networkAddress: info.network_address }
          : null),
      });
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * pull epoch info and global stake stats from the Ika system inner via the SDK's parsed cache.
 * forces a fresh fetch by invalidating the object cache first so the page's "updated Ns ago"
 * pill is honest. cheap enough to poll on a 30s cadence for the header countdown.
 */
export async function getIkaSystemSnapshotForSession(): Promise<IkaSystemSnapshot> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  assertSuiBaseIkaSession(s);
  s.ikaClient.invalidateObjectCache();
  const { systemInner } = await s.ikaClient.ensureInitialized();

  const epoch = Number(systemInner.epoch);
  const epochStartTimestampMs = Number(systemInner.epoch_start_timestamp_ms);
  const epochDurationMs = Number(systemInner.epoch_duration_ms);
  const protocolVersion = Number(systemInner.protocol_version);
  const totalStakeBaseUnits = String(systemInner.validator_set.total_stake);
  const stakeSubsidyAmountPerDistributionBaseUnits = String(
    systemInner.protocol_treasury.stake_subsidy_amount_per_distribution,
  );
  const activeValidatorCount = systemInner.validator_set.active_committee.members.length;

  return {
    epoch,
    epochStartTimestampMs,
    epochDurationMs,
    protocolVersion,
    totalStakeBaseUnits,
    stakeSubsidyAmountPerDistributionBaseUnits,
    activeValidatorCount,
    fetchedAtMs: Date.now(),
  };
}

/**
 * approximate net APY for a validator under the assumption that the protocol's per-epoch
 * stake subsidy is split equally across the active committee, then divided pro-rata to that
 * validator's stake. labelled `~APY` in the UI because we can't observe the on-chain
 * distribution formula exactly; small drift from third-party indexers is expected.
 *
 * returns null when the validator can't earn (zero stake, PreActive, missing snapshot).
 */
export function computeValidatorApyPercent(
  v: Pick<IkaValidatorRow, 'totalStakeBaseUnits' | 'commissionRateBps' | 'status'>,
  snapshot: Pick<
    IkaSystemSnapshot,
    'stakeSubsidyAmountPerDistributionBaseUnits' | 'activeValidatorCount' | 'epochDurationMs'
  >,
): number | null {
  if (v.status !== 'Active') return null;
  const totalStake = Number(BigInt(v.totalStakeBaseUnits || '0'));
  if (totalStake <= 0) return null;
  const subsidyPerEpoch = Number(BigInt(snapshot.stakeSubsidyAmountPerDistributionBaseUnits || '0'));
  if (subsidyPerEpoch <= 0 || snapshot.activeValidatorCount <= 0) return null;
  if (snapshot.epochDurationMs <= 0) return null;

  const perValidatorPerEpoch = subsidyPerEpoch / snapshot.activeValidatorCount;
  const epochsPerYear = (365 * 24 * 60 * 60 * 1000) / snapshot.epochDurationMs;
  const grossApy = (perValidatorPerEpoch / totalStake) * epochsPerYear;
  const netApy = grossApy * (1 - v.commissionRateBps / 10_000);
  return netApy * 100;
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
      const activationEpoch = toIntOrNull(j.activation_epoch) ?? toIntOrNull((j as { stake_activation_epoch?: unknown }).stake_activation_epoch);
      out.push({
        objectId: o.objectId,
        validatorId,
        principalBaseUnits: principal,
        ...(activationEpoch !== null ? { activationEpoch } : null),
      });
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

  const op = beginOperation('Stake IKA');
  try {
    await op.updateStage('preparing', 'Gathering IKA coins…');
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

    await op.updateStage('executing', 'Submitting stake transaction…');
    const result = await executeSuiTransaction(s, tx, { include: { effects: true } });
    if (result.$kind === 'FailedTransaction') {
      const err = result.FailedTransaction.status.error;
      throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
    }
    await op.succeed('Staked');
  } catch (e) {
    await op.fail(e instanceof Error ? e.message : String(e));
    throw e;
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

  const op = beginOperation('Withdraw stake');
  try {
    await op.updateStage('preparing', 'Checking withdrawal path…');
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

    await op.updateStage('executing', 'Submitting withdraw transaction…');
    const result = await executeSuiTransaction(s, tx, { include: { effects: true } });
    if (result.$kind === 'FailedTransaction') {
      const err = result.FailedTransaction.status.error;
      throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
    }
    await op.succeed(useDirectWithdraw ? 'Withdrawn' : 'Withdraw requested');
  } catch (e) {
    await op.fail(e instanceof Error ? e.message : String(e));
    throw e;
  }
}
