/**
 * thin Sui helpers for the funder Worker. wraps `@mysten/sui` so `index.ts` stays small.
 *
 * we deliberately do NOT depend on chromatika code: the Worker is its own pnpm package and
 * the wallet-extension can't import out of its own tree. the patterns here mirror
 * `wallet-extension/src/background/ika/coins.ts` (largest IKA coin selection) and
 * `wallet-extension/src/background/chains/sui-send-native.ts` (single PTB with `tx.gas` for
 * SUI + an explicit IKA coin object), but reimplemented standalone.
 *
 * intentionally NO retry/backoff/throttle wrapper around `fetch` here - the Worker's QPS
 * ceiling is already bounded by `DAILY_CAP`. if the upstream GraphQL endpoint 429s during a
 * funding attempt we return 502 and the user retries via the chromatika banner.
 */

import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';

const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

export type FunderEnv = {
  SUI_GRAPHQL_URL: string;
  IKA_COIN_TYPE: string;
};

export function createGraphQLClient(env: FunderEnv): SuiGraphQLClient {
  return new SuiGraphQLClient({ url: env.SUI_GRAPHQL_URL, network: 'mainnet' });
}

/**
 * load the team's Ed25519 keypair from a `suiprivkey1...` bech32 string. throws with a
 * specific message if the string is wrong-length or wrong-scheme so the operator can
 * diagnose `wrangler secret put` mistakes from `wrangler tail`.
 */
export function loadFunderKeypair(suiPrivkeyBech32: string): Ed25519Keypair {
  const trimmed = suiPrivkeyBech32.trim();
  if (!trimmed.startsWith('suiprivkey1')) {
    throw new Error('FUNDER_SUI_PRIVKEY must be a Sui bech32 private key (starts with `suiprivkey1...`).');
  }
  const decoded = decodeSuiPrivateKey(trimmed);
  if (decoded.scheme !== 'ED25519') {
    throw new Error(`FUNDER_SUI_PRIVKEY: only ED25519 keys are supported, got ${decoded.scheme}.`);
  }
  return Ed25519Keypair.fromSecretKey(decoded.secretKey);
}

/** normalized `Coin<T>` struct tag for filtering listCoins results. */
function wrappedCoinType(innerCoinType: string): string {
  return normalizeStructTag(`0x2::coin::Coin<${innerCoinType}>`);
}

/**
 * find the team's largest IKA coin object id. picking the largest avoids splitting the same
 * coin twice in close succession when the indexer hasn't caught up. we don't need to merge or
 * split here - the PTB itself splits the funding amount off the coin we point it at.
 *
 * throws when no IKA coin exists (operator hasn't funded the worker wallet yet) or when the
 * largest IKA coin's balance is below `requiredAmount` (worker is running dry; operator should
 * top up).
 */
export async function findLargestIkaCoin(
  client: SuiGraphQLClient,
  funderAddress: string,
  ikaCoinType: string,
  requiredAmount: bigint,
): Promise<{ id: string; balance: bigint }> {
  const want = wrappedCoinType(ikaCoinType);
  let best: { id: string; balance: bigint } | null = null;
  let cursor: string | null = null;
  for (;;) {
    const res = await client.listCoins({
      owner: funderAddress,
      coinType: ikaCoinType,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    for (const o of res.objects) {
      if (normalizeStructTag(o.type) !== want) continue;
      const balance = BigInt(o.balance ?? '0');
      if (best === null || balance > best.balance) best = { id: o.objectId, balance };
    }
    if (!res.hasNextPage) break;
    cursor = res.cursor;
  }
  if (!best) {
    throw new Error('Funder wallet has no IKA coins. Top up the team funder address with mainnet IKA.');
  }
  if (best.balance < requiredAmount) {
    throw new Error(
      `Funder wallet's largest IKA coin (${best.balance.toString()} base units) is below required ${requiredAmount.toString()}. Top up.`,
    );
  }
  return best;
}

/**
 * build + sign + execute the single funding PTB. splits SUI off `tx.gas` and IKA off the team's
 * largest IKA coin, transfers both to the recipient, returns the digest.
 *
 * `ikaCoinId` is computed by `findLargestIkaCoin` ahead of this call so the GraphQL lookup
 * happens once per request.
 */
export async function executeFundingPtb(args: {
  client: SuiGraphQLClient;
  signer: Ed25519Keypair;
  recipient: string;
  ikaCoinId: string;
  ikaAmount: bigint;
  suiAmount: bigint;
}): Promise<{ digest: string }> {
  const { client, signer, recipient, ikaCoinId, ikaAmount, suiAmount } = args;
  const tx = new Transaction();
  const [ikaSplit] = tx.splitCoins(tx.object(ikaCoinId), [ikaAmount]);
  const [suiSplit] = tx.splitCoins(tx.gas, [suiAmount]);
  tx.transferObjects([ikaSplit, suiSplit], recipient);
  const result = await client.signAndExecuteTransaction({ transaction: tx, signer });
  const digest = (result as { digest?: string }).digest;
  if (!digest) {
    throw new Error('Sui execute returned no digest');
  }
  return { digest };
}

export { normalizeSuiAddress, SUI_TYPE };
