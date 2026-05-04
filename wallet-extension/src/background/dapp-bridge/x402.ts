/**
 * x402 dapp-bridge handler.
 *
 * two methods routed through the existing dapp-bridge port:
 *   - `chromatika_x402_handle_402` - fetched from a page that hit 402, returns the signed
 *     PAYMENT-SIGNATURE header value (after popup approval).
 *   - `chromatika_x402_record_settlement` - fired after the page sees PAYMENT-RESPONSE on the
 *     retry, updates the receipt with on-chain digest + final status.
 *
 * the injected fetch wrapper (`dapp-interface/x402-fetch-wrapper.ts`) calls the first method
 * synchronously in the request flow so the user sees the popup immediately. settlement record
 * is fire-and-forget on the page side.
 */

import type { BridgeCtx, HandlerResult } from './internal';
import {
  dispatchX402PaymentRequired,
  recordX402Settlement,
} from '@/background/x402/x402-dispatch';

const METHOD_HANDLE_402 = 'chromatika_x402_handle_402';
const METHOD_RECORD_SETTLEMENT = 'chromatika_x402_record_settlement';

export async function handleX402Method(ctx: BridgeCtx): Promise<HandlerResult> {
  const { method, params, origin, log } = ctx;
  if (method !== METHOD_HANDLE_402 && method !== METHOD_RECORD_SETTLEMENT) return null;

  const arg = (params ?? [])[0];
  if (!arg || typeof arg !== 'object') {
    return { ok: false, error: `${method} requires a single object param` };
  }

  if (method === METHOD_HANDLE_402) {
    const { paymentRequiredHeaderB64, resourceUrl, callerHint } = arg as {
      paymentRequiredHeaderB64?: string;
      resourceUrl?: string;
      callerHint?: string;
    };
    if (typeof paymentRequiredHeaderB64 !== 'string' || paymentRequiredHeaderB64.length === 0) {
      return { ok: false, error: 'paymentRequiredHeaderB64 is required' };
    }
    try {
      // origin is the validated tab origin from the content script. prefer the explicit
      // callerHint when the page passes one, fall back to origin / resource url.
      const hint = (callerHint ?? origin ?? resourceUrl ?? '').toString().slice(0, 256);
      const result = await dispatchX402PaymentRequired({
        paymentRequiredHeaderB64,
        callerHint: hint || undefined,
      });
      await log(true);
      return { ok: true, result };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await log(false, reason);
      return { ok: false, error: reason };
    }
  }

  // METHOD_RECORD_SETTLEMENT
  const { receiptId, paymentResponseHeaderB64 } = arg as {
    receiptId?: string;
    paymentResponseHeaderB64?: string;
  };
  if (typeof receiptId !== 'string' || receiptId.length === 0) {
    return { ok: false, error: 'receiptId is required' };
  }
  if (typeof paymentResponseHeaderB64 !== 'string' || paymentResponseHeaderB64.length === 0) {
    return { ok: false, error: 'paymentResponseHeaderB64 is required' };
  }
  try {
    const updated = await recordX402Settlement({ receiptId, paymentResponseHeaderB64 });
    return { ok: true, result: updated };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
