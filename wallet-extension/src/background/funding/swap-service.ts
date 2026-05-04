/**
 * swap-service.ts - aftermath router integration for phase B Sui-native IKA top-up.
 *
 * zero new npm deps: uses fetch() to Aftermath REST API, deserializes returned
 * transaction bytes into a @mysten/sui Transaction, signs with suiKeypair.
 *
 * aftermath aggregates across Cetus, DeepBook, Turbos, FlowX, etc. so we get
 * the best route without integrating each DEX individually.
 */

import { Transaction } from '@mysten/sui/transactions';
import { getSession } from '@/background/session';
import { executeSuiTransaction } from '@/background/sui/execute-transaction';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';
import { ikaCoinType, getSuiBalanceMist, getIkaBalanceBaseUnits } from '@/background/ika/coins';
import {
  AFTERMATH_API_BASE,
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

// ---------- aftermath REST helpers ----------

function aftermathBaseUrl(): string {
  const s = getSession();
  const net = s?.network ?? 'mainnet';
  return AFTERMATH_API_BASE[net];
}

/**
 * fetch a swap route + transaction bytes from Aftermath router.
 *
 * aftermath's /router/transactions endpoint returns a serialized Transaction
 * that we can deserialize and sign locally.
 *
 * docs: https://aftermath.finance/docs/router (the public-facing route endpoint)
 */
async function fetchAftermathRoute(
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
  const base = aftermathBaseUrl();
  const slippageDecimal = slippageBps / 10_000;

  // step 1: get route + quote
  const routeRes = await fetch(`${base}/router/trade/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      coinInType: fromCoinType,
      coinOutType: toCoinType,
      coinInAmount: amountInBaseUnits.toString(),
      slippage: slippageDecimal,
      senderAddress,
    }),
  });

  if (!routeRes.ok) {
    const body = await routeRes.text().catch(() => '');
    throw new Error(
      `aftermath router error (${routeRes.status}): ${body || routeRes.statusText}`,
    );
  }

  const route = (await routeRes.json()) as {
    coinOut?: { amount?: string };
    spotPrice?: number;
    priceImpact?: number;
    routes?: Array<{ protocol?: string }>;
  };

  const expectedOut = BigInt(route.coinOut?.amount ?? '0');
  if (expectedOut === 0n) {
    throw new Error('no swap route found, IKA/SUI pool may not have liquidity on this network');
  }

  const priceImpactPct = (route.priceImpact ?? 0).toFixed(4);
  const protocols = (route.routes ?? []).map((r) => r.protocol ?? '?').join(' -> ');
  const routeSummary = protocols || 'direct';

  // step 2: get transaction bytes for this route
  const txRes = await fetch(`${base}/router/trade/transaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      coinInType: fromCoinType,
      coinOutType: toCoinType,
      coinInAmount: amountInBaseUnits.toString(),
      slippage: slippageDecimal,
      senderAddress,
    }),
  });

  if (!txRes.ok) {
    const body = await txRes.text().catch(() => '');
    throw new Error(
      `aftermath tx build error (${txRes.status}): ${body || txRes.statusText}`,
    );
  }

  const txData = (await txRes.json()) as { tx?: string; txBytes?: string };
  const txBytesB64 = txData.tx ?? txData.txBytes ?? '';
  if (!txBytesB64) {
    throw new Error('aftermath returned empty transaction bytes');
  }

  // calculate min out with slippage
  const minOut = expectedOut - (expectedOut * BigInt(slippageBps)) / 10_000n;

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

  const { expectedOut, minOut, priceImpactPct, txBytesB64, routeSummary } =
    await fetchAftermathRoute(SUI_COIN_TYPE, ikaType, amount, slippageBps, owner);

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

  // check for success
  const status = (result as { effects?: { status?: { status?: string } } })
    ?.effects?.status?.status;
  if (status !== 'success') {
    throw new Error(`swap transaction failed: ${status ?? 'unknown'}`);
  }

  // extract IKA received from balance changes
  const ikaType = quote.toCoinType;
  const changes = (result as { balanceChanges?: Array<{ coinType?: string; amount?: string }> })
    ?.balanceChanges ?? [];
  const ikaChange = changes.find((c) => c.coinType === ikaType);
  const received = ikaChange?.amount ?? quote.expectedOutBaseUnits;

  // clear the cache
  cachedQuote = null;

  return {
    txDigest: (result as { digest?: string }).digest ?? 'unknown',
    ikaReceivedBaseUnits: received,
  };
}
