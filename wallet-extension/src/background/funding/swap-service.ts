/**
 * swap-service.ts - aftermath router integration for phase B Sui-native IKA top-up.
 *
 * uses `aftermath-ts-sdk` Router (replaced deprecated REST `/router/trade/*` which 404s).
 * builds a Mysten `Transaction`, serializes bytes for the quote cache, signs via fee payer.
 */

import { Aftermath } from 'aftermath-ts-sdk';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import type { SessionState } from '@/background/session';
import { getSession } from '@/background/session';
import { executeSuiTransaction } from '@/background/sui/execute-transaction';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';
import type { SuiNetworkId } from '@/config/sui';
import { ikaCoinType, getSuiBalanceMist, getIkaBalanceBaseUnits } from '@/background/ika/coins';
import {
  SUI_COIN_TYPE,
  MIN_SUI_RESERVE_MIST,
  DEFAULT_SLIPPAGE_BPS,
  QUOTE_CACHE_TTL_MS,
} from './swap-config';

// ---------- types ----------

export interface SwapQuote {
  /** unique id for this quote (generated locally) */
  id: string;
  fromCoinType: string;
  toCoinType: string;
  amountInBaseUnits: string;
  expectedOutBaseUnits: string;
  /** minimum output after slippage */
  minOutBaseUnits: string;
  slippageBps: number;
  /** price impact as a percentage string, e.g. "0.42" */
  priceImpactPct: string;
  /** base64 tx bytes from aftermath router, deserializable into Transaction */
  txBytesB64: string;
  /** when this quote was fetched (epoch ms) */
  fetchedAtEpochMs: number;
  /** human summary for the UI */
  routeSummary: string;
}

export interface SwapResult {
  txDigest: string;
  ikaReceivedBaseUnits: string;
}

// ---------- quote cache ----------

let cachedQuote: SwapQuote | null = null;

function cacheQuote(q: SwapQuote): SwapQuote {
  cachedQuote = q;
  return q;
}

function getCachedQuote(id: string): SwapQuote | null {
  if (!cachedQuote || cachedQuote.id !== id) return null;
  if (Date.now() - cachedQuote.fetchedAtEpochMs > QUOTE_CACHE_TTL_MS) {
    cachedQuote = null;
    return null;
  }
  return cachedQuote;
}

function aftermathSdkNetwork(network: SuiNetworkId): 'MAINNET' | 'TESTNET' {
  return network === 'testnet' ? 'TESTNET' : 'MAINNET';
}

function summarizeAftermathRoute(route: {
  routes: Array<{ paths: Array<{ protocolName: string }> }>;
  netTradeFeePercentage?: number;
}): string {
  const names: string[] = [];
  for (const r of route.routes) {
    for (const p of r.paths) {
      names.push(p.protocolName);
    }
  }
  const chain = names.length ? [...new Set(names)].join(' → ') : 'aggregated';
  const fee = route.netTradeFeePercentage;
  if (fee !== undefined && fee > 0) {
    return `${chain} (~${(fee * 100).toFixed(2)}% route fee)`;
  }
  return chain;
}

/**
 * fetch a swap route and build serialized tx bytes via Aftermath SDK Router.
 */
async function fetchAftermathRoute(
  session: SessionState,
  fromCoinType: string,
  toCoinType: string,
  amountInBaseUnits: bigint,
  slippageBps: number,
  senderAddress: string,
): Promise<{
  expectedOut: bigint;
  minOut: bigint;
  priceImpactPct: string;
  txBytesB64: string;
  routeSummary: string;
}> {
  const slippageDecimal = slippageBps / 10_000;
  const af = new Aftermath(aftermathSdkNetwork(session.network));
  await af.init();
  const router = af.Router();

  const route = await router.getCompleteTradeRouteGivenAmountIn({
    coinInType: fromCoinType,
    coinOutType: toCoinType,
    coinInAmount: amountInBaseUnits,
  });

  const expectedOut = route.coinOut.amount;
  if (expectedOut === 0n) {
    throw new Error('no swap route found, IKA/SUI pool may not have liquidity on this network');
  }

  const tx = await router.getTransactionForCompleteTradeRoute({
    walletAddress: senderAddress,
    completeRoute: route,
    slippage: slippageDecimal,
  });
  tx.setSender(senderAddress);

  const built = await tx.build({ client: session.suiClient });
  const txBytesB64 = toBase64(new Uint8Array(built));

  const minOut = expectedOut - (expectedOut * BigInt(slippageBps)) / 10_000n;
  const routeSummary = summarizeAftermathRoute(route);

  // aftermath SDK route object does not expose price impact; keep a stable placeholder for the UI.
  const priceImpactPct = '0.0000';

  return { expectedOut, minOut, priceImpactPct, txBytesB64, routeSummary };
}

// ---------- public API ----------

/**
 * get swap status: does the user need a swap? what are their balances?
 * returns enough info for the UI to show a "swap SUI to IKA" CTA.
 */
export async function getSwapStatus(): Promise<{
  needsSwap: boolean;
  suiBalanceMist: string;
  ikaBalanceBaseUnits: string;
  canSwap: boolean;
  reason: string | null;
}> {
  const s = getSession();
  if (!s) return { needsSwap: false, suiBalanceMist: '0', ikaBalanceBaseUnits: '0', canSwap: false, reason: 'locked' };

  const owner = getSuiFeePayerSuiAddress(s);
  const ikaConfig = s.ikaClient.ikaConfig;

  const [suiBal, ikaBal] = await Promise.all([
    getSuiBalanceMist(s.suiClient, owner),
    getIkaBalanceBaseUnits(s.suiClient, ikaConfig, owner),
  ]);

  const needsSwap = ikaBal === 0n;
  const hasEnoughSui = suiBal > MIN_SUI_RESERVE_MIST;

  let reason: string | null = null;
  if (!needsSwap) reason = 'already has IKA';
  else if (!hasEnoughSui) reason = 'insufficient SUI - need at least 0.05 SUI to swap and keep gas';

  return {
    needsSwap,
    suiBalanceMist: suiBal.toString(),
    ikaBalanceBaseUnits: ikaBal.toString(),
    canSwap: needsSwap && hasEnoughSui,
    reason,
  };
}

/**
 * fetch a quote for swapping SUI -> IKA.
 * the caller picks the amount; if null, we compute a recommended amount.
 */
export async function getSwapQuote(
  amountInMist?: string,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
): Promise<SwapQuote> {
  const s = getSession();
  if (!s) throw new Error('wallet is locked');

  const owner = getSuiFeePayerSuiAddress(s);
  const ikaType = ikaCoinType(s.ikaClient.ikaConfig);

  // if no amount specified, compute a sensible default
  let amount: bigint;
  if (amountInMist) {
    amount = BigInt(amountInMist);
  } else {
    const suiBal = await getSuiBalanceMist(s.suiClient, owner);
    // swap half of (balance - reserve), capped at a reasonable max
    const available = suiBal > MIN_SUI_RESERVE_MIST ? suiBal - MIN_SUI_RESERVE_MIST : 0n;
    const MAX_AUTO_SWAP_MIST = 500_000_000n; // 0.5 SUI
    amount = available > MAX_AUTO_SWAP_MIST ? MAX_AUTO_SWAP_MIST : available / 2n;
    if (amount === 0n) throw new Error('insufficient SUI for swap after reserving gas');
  }

  // verify the user keeps enough SUI after the swap
  const suiBal = await getSuiBalanceMist(s.suiClient, owner);
  if (suiBal - amount < MIN_SUI_RESERVE_MIST) {
    throw new Error(
      `swap would leave less than ${Number(MIN_SUI_RESERVE_MIST) / 1e9} SUI for gas, reduce amount`,
    );
  }

  const { expectedOut, minOut, priceImpactPct, txBytesB64, routeSummary } = await fetchAftermathRoute(
    s,
    SUI_COIN_TYPE,
    ikaType,
    amount,
    slippageBps,
    owner,
  );

  const quote: SwapQuote = {
    id: `swap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fromCoinType: SUI_COIN_TYPE,
    toCoinType: ikaType,
    amountInBaseUnits: amount.toString(),
    expectedOutBaseUnits: expectedOut.toString(),
    minOutBaseUnits: minOut.toString(),
    slippageBps,
    priceImpactPct,
    txBytesB64,
    fetchedAtEpochMs: Date.now(),
    routeSummary,
  };

  return cacheQuote(quote);
}

/**
 * execute a previously-fetched swap quote. deserializes the aftermath tx,
 * signs with suiKeypair, executes on Sui.
 *
 * `quoteFromClient` must be passed from the UI: MV3 can restart the service worker between
 * swapQuote and executeSwap, which clears the in-memory cache and made swaps look like a no-op.
 */
export async function executeSwap(quoteId: string, quoteFromClient?: SwapQuote): Promise<SwapResult> {
  const s = getSession();
  if (!s) throw new Error('wallet is locked');

  const quote =
    quoteFromClient && quoteFromClient.id === quoteId
      ? quoteFromClient
      : getCachedQuote(quoteId);
  if (!quote) throw new Error('quote expired or not found, fetch a new quote');

  if (Date.now() - quote.fetchedAtEpochMs > QUOTE_CACHE_TTL_MS) {
    throw new Error('quote expired, tap get quote again');
  }

  // deserialize the transaction bytes from aftermath
  const txBytes = Uint8Array.from(atob(quote.txBytesB64), (c) => c.charCodeAt(0));
  const tx = Transaction.from(txBytes);

  // set the sender explicitly (aftermath may or may not have set it)
  tx.setSender(getSuiFeePayerSuiAddress(s));

  // execute: suiKeypair signs automatically
  const result = await executeSuiTransaction(s, tx, {
    include: { effects: true, balanceChanges: true },
  });

  // GraphQL `signAndExecuteTransaction` returns `{ $kind: 'Transaction' | 'FailedTransaction', … }`
  // (same shape as ika presign). do not use JSON-RPC `effects.status.status`.
  if (result.$kind === 'FailedTransaction') {
    const failErr = result.FailedTransaction?.status?.error;
    const reason = typeof failErr === 'string' ? failErr : JSON.stringify(failErr ?? 'unknown');
    throw new Error(`swap transaction failed: ${reason}`);
  }

  const executed = result.Transaction;
  if (!executed) {
    throw new Error('swap transaction failed: missing transaction result');
  }

  // extract IKA received from balance changes
  const ikaType = quote.toCoinType;
  const changes = (executed.balanceChanges ?? []) as Array<{ coinType?: string; amount?: string | bigint }>;
  const ikaChange = changes.find((c) => c.coinType === ikaType);
  const received =
    ikaChange?.amount != null ? String(ikaChange.amount) : quote.expectedOutBaseUnits;

  // clear the cache
  cachedQuote = null;

  return {
    txDigest: executed.digest ?? 'unknown',
    ikaReceivedBaseUnits: received,
  };
}
