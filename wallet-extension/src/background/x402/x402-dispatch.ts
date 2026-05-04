/**
 * x402 dispatcher: orchestrates a single PAYMENT-REQUIRED -> user approval -> signed payload.
 *
 * lifecycle (one call per 402):
 *   1. caller passes the base64 PAYMENT-REQUIRED header value + the resource URL (from the
 *      page that hit the 402) + an optional human-readable callerHint.
 *   2. decode PaymentRequirements; validate scheme = exact, network = solana, asset = USDC.
 *   3. compute a best-effort USD estimate (USDC = $1 to 6 decimals; safe fixed for v1).
 *   4. load caps + today's spend; run synchronous wouldExceedCaps; reject early on breach.
 *   5. mint a receipt id, append a receipt with status='pending'.
 *   6. enqueue the approval request: this opens the popup. await the user.
 *   7. on approve: the popup-side tRPC handler runs `buildAndSignX402Solana`, then resolves
 *      the queued promise with the signed payload.
 *   8. update the receipt with signature + status (still 'pending' until settlement); the
 *      caller updates again with the on-chain digest after the server returns PAYMENT-RESPONSE.
 *   9. return the headerValue (base64-encoded PaymentPayload) so the caller can retry the
 *      original fetch with `PAYMENT-SIGNATURE: <headerValue>`.
 *
 * settlement bookkeeping (`recordX402Settlement`) lives separately so the page-side fetch
 * wrapper can call it after parsing the server's PAYMENT-RESPONSE header on the retry.
 */

import {
  effectivePerCounterpartyCap,
  getX402Caps,
  wouldExceedCaps,
} from './x402-caps';
import {
  appendReceipt,
  computeTodaysSpend,
  newReceiptId,
  updateReceipt,
  type X402Receipt,
  type X402ReceiptStatus,
} from './x402-receipts';
import { enqueueX402Approval, type X402ApprovedResult } from './x402-pending-queue';
import {
  X402_SOLANA_USDC_MINT_MAINNET,
  decodeBase64Json,
  isSolanaCaip2,
  sellerHostFromResource,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentResponse,
} from './x402-types';

/** USDC has 6 decimals. v1 assumes the asset is USDC and amounts map 1:1 USD per token unit. */
const USDC_DECIMALS = 6;

function estimateUsd(requirements: PaymentRequirements): number | null {
  // v1 is USDC-only: amount in atomic units / 10^6 = USD.
  if (requirements.asset !== X402_SOLANA_USDC_MINT_MAINNET) {
    // unknown asset: skip the estimate so the cap check uses 0 (effectively allows the call
    // but logs a receipt with null USD; future slice adds a real price waterfall).
    return null;
  }
  try {
    const atomic = BigInt(requirements.maxAmountRequired);
    // convert to USD as a number; safe up to ~9e15 USD which is way past any real x402 amount.
    const whole = Number(atomic / 10n ** BigInt(USDC_DECIMALS));
    const frac = Number(atomic % 10n ** BigInt(USDC_DECIMALS)) / 10 ** USDC_DECIMALS;
    return whole + frac;
  } catch {
    return null;
  }
}

export type X402DispatchInput = {
  /** raw `PAYMENT-REQUIRED` header value (base64-encoded JSON). */
  paymentRequiredHeaderB64: string;
  /** optional caller display hint, e.g. originating page URL or 'mcp:<agent>'. */
  callerHint?: string;
};

export type X402DispatchResult = {
  /** pre-encoded PAYMENT-SIGNATURE header value (base64). */
  headerValue: string;
  /** receipt id; caller passes this back to `recordX402Settlement` after seeing PAYMENT-RESPONSE. */
  receiptId: string;
  /** PaymentRequirements echoed back (decoded form); useful for UI to render seller summary. */
  requirements: PaymentRequirements;
};

/**
 * run the full dispatch lifecycle: decode -> validate -> caps check -> enqueue approval popup ->
 * await user -> return signed header. throws on any guard failure (so the caller sees a real
 * error rather than a silently-malformed payload).
 */
export async function dispatchX402PaymentRequired(input: X402DispatchInput): Promise<X402DispatchResult> {
  const requirements = decodeBase64Json<PaymentRequirements>(input.paymentRequiredHeaderB64);
  if (!requirements) {
    throw new Error('PAYMENT-REQUIRED header is not valid base64-encoded JSON');
  }
  validateRequirements(requirements);

  const sellerHost =
    sellerHostFromResource(requirements.resource) ??
    (requirements.payTo.length > 0 ? requirements.payTo : 'unknown');

  const estimatedUsd = estimateUsd(requirements);
  const paymentForCapCheckUsd = estimatedUsd ?? 0;

  const caps = await getX402Caps();
  const spendToday = await computeTodaysSpend();
  const capCheck = wouldExceedCaps({
    caps,
    spendToday,
    paymentUsd: paymentForCapCheckUsd,
    sellerHost,
  });
  if (!capCheck.ok) {
    throw new Error(
      `x402 cap exceeded: ${capCheck.reason}. (open Settings → Payments to raise the limit, ` +
        `currently per-host $${effectivePerCounterpartyCap(caps, sellerHost)}/day; ` +
        `global $${caps.globalDailyCapUsd ?? 'unlimited'}/day)`,
    );
  }

  // mint the receipt id up front so the popup + caller can refer to the same row.
  const receiptId = newReceiptId();
  const baseReceipt: X402Receipt = {
    id: receiptId,
    enqueuedAtMs: Date.now(),
    settledAtMs: null,
    sellerHost,
    sellerAddress: requirements.payTo,
    resourceUrl: requirements.resource,
    network: requirements.network,
    asset: requirements.asset,
    amountAtomic: requirements.maxAmountRequired,
    amountUsdEstimate: estimatedUsd,
    signatureHex: null,
    settlementTxHash: null,
    status: 'pending',
    errorReason: null,
    responseQuality: null,
  };
  await appendReceipt(baseReceipt);

  let approved: X402ApprovedResult;
  try {
    approved = await enqueueX402Approval({
      requirements,
      sellerHost,
      estimatedUsd,
      callerHint: input.callerHint ?? null,
      receiptId,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await updateReceipt(receiptId, { status: 'rejected', errorReason: reason });
    throw e;
  }

  // first half of the round-trip done. record the signature; settlement digest fills in later.
  await updateReceipt(receiptId, {
    signatureHex: deriveSignatureHexFromHeader(approved.headerValue),
  });

  return {
    headerValue: approved.headerValue,
    receiptId,
    requirements,
  };
}

/**
 * caller invokes this after seeing the server's PAYMENT-RESPONSE header on the retry. updates
 * the receipt to `settled` (success) or `failed` (with reason) so daily cap accounting + UI
 * stay accurate.
 */
export async function recordX402Settlement(args: {
  receiptId: string;
  paymentResponseHeaderB64: string;
}): Promise<X402Receipt | null> {
  const parsed = decodeBase64Json<PaymentResponse>(args.paymentResponseHeaderB64);
  if (!parsed) {
    return updateReceipt(args.receiptId, {
      status: 'failed',
      errorReason: 'PAYMENT-RESPONSE header could not be decoded',
    });
  }
  const status: X402ReceiptStatus = parsed.success ? 'settled' : 'failed';
  return updateReceipt(args.receiptId, {
    status,
    settledAtMs: Date.now(),
    settlementTxHash: parsed.transaction ?? null,
    errorReason: parsed.success ? null : (parsed.errorReason ?? 'settlement failed'),
  });
}

function validateRequirements(req: PaymentRequirements): void {
  if (req.scheme !== 'exact') {
    throw new Error(`x402 v1 only supports the 'exact' scheme; got '${req.scheme}'`);
  }
  if (!isSolanaCaip2(req.network)) {
    throw new Error(`x402 v1 only supports Solana networks; got '${req.network}'`);
  }
  if (req.asset !== X402_SOLANA_USDC_MINT_MAINNET) {
    throw new Error(
      `x402 v1 only supports USDC (${X402_SOLANA_USDC_MINT_MAINNET}); got asset '${req.asset}'`,
    );
  }
  if (typeof req.maxAmountRequired !== 'string' || req.maxAmountRequired.length === 0) {
    throw new Error('PaymentRequirements.maxAmountRequired must be a non-empty string');
  }
  if (typeof req.payTo !== 'string' || req.payTo.length === 0) {
    throw new Error('PaymentRequirements.payTo must be a non-empty string');
  }
  if (typeof req.resource !== 'string' || req.resource.length === 0) {
    throw new Error('PaymentRequirements.resource must be a non-empty string');
  }
  if (req.expiresAt != null && typeof req.expiresAt === 'number') {
    const nowSec = Math.floor(Date.now() / 1000);
    if (req.expiresAt < nowSec) {
      throw new Error('PaymentRequirements has expired (expiresAt is in the past)');
    }
  }
}

/**
 * pull the inner payload out of the base64 PaymentPayload envelope so we can record an
 * easily-greppable signature reference on the receipt. best-effort: returns null on parse
 * failure rather than throwing (the receipt update is bookkeeping, not load-bearing).
 */
function deriveSignatureHexFromHeader(headerValueB64: string): string | null {
  const envelope = decodeBase64Json<PaymentPayload>(headerValueB64);
  if (!envelope || typeof envelope !== 'object') return null;
  const inner = envelope.payload as { transaction?: string } | null | undefined;
  if (!inner || typeof inner.transaction !== 'string') return null;
  // we don't try to decode the wire tx here: the base64 transaction itself is the canonical
  // record. cap to first 32 chars for compactness in the receipt log.
  return inner.transaction.slice(0, 32);
}
