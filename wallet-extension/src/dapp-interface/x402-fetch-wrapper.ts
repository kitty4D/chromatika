/**
 * x402 fetch interception (page world).
 *
 * wraps `window.fetch` so any page response with `HTTP 402 + PAYMENT-REQUIRED` is auto-routed
 * through the chromatika wallet:
 *   1. catch the 402, extract `PAYMENT-REQUIRED` (base64 PaymentRequirements).
 *   2. ask the wallet to sign via the existing dapp-bridge port (postToExtension); the bridge
 *      runs caps + the approval popup + the Solana exact-scheme signer.
 *   3. retry the original fetch with `payment-signature: <headerValue>` added to the headers.
 *   4. capture `payment-response` on the retry; fire-and-forget settlement record so the
 *      wallet's receipt log gets the on-chain digest + final status.
 *
 * failure modes: on any wallet error (caps exceeded, user rejected, signer threw, retry
 * network error) the wrapper returns the ORIGINAL 402 response. the page sees the same
 * failure it would've seen without chromatika, so dapps that explicitly handle 402 can still
 * fall back to their own flow.
 *
 * the wrapper only triggers on responses that explicitly carry the `payment-required` header.
 * plain 402 responses (without the header, which violates the spec) pass through unchanged.
 */

type PostToExtension = (req: { method: string; params?: unknown[] }) => Promise<unknown>;

type X402SignResult = {
  headerValue: string;
  receiptId: string;
};

const INSTALLED_FLAG = '__chromatikaX402FetchInstalled';

export function installX402FetchWrapper(postToExtension: PostToExtension): void {
  // never double-wrap. structured-clone-safe flag so re-injection doesn't break.
  const wnd = window as unknown as Record<string, unknown>;
  if (wnd[INSTALLED_FLAG]) return;
  wnd[INSTALLED_FLAG] = true;

  const originalFetch: typeof fetch = window.fetch.bind(window);

  async function chromatikaFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const response = await originalFetch(input, init);
    if (response.status !== 402) return response;

    const paymentRequiredHeaderB64 = response.headers.get('payment-required');
    if (!paymentRequiredHeaderB64) return response;

    let resourceUrl: string;
    try {
      if (typeof input === 'string') resourceUrl = input;
      else if (input instanceof URL) resourceUrl = input.toString();
      else if (input && typeof (input as { url?: unknown }).url === 'string') {
        resourceUrl = (input as { url: string }).url;
      } else {
        resourceUrl = window.location.href;
      }
    } catch {
      resourceUrl = window.location.href;
    }

    let signed: X402SignResult;
    try {
      const r = await postToExtension({
        method: 'chromatika_x402_handle_402',
        params: [
          {
            paymentRequiredHeaderB64,
            resourceUrl,
            callerHint: window.location.host,
          },
        ],
      });
      const cast = r as { headerValue?: unknown; receiptId?: unknown };
      if (typeof cast.headerValue !== 'string' || typeof cast.receiptId !== 'string') {
        return response;
      }
      signed = { headerValue: cast.headerValue, receiptId: cast.receiptId };
    } catch {
      // wallet rejected (caps, user cancel, signer error, etc.) - surface the original 402.
      return response;
    }

    // build retry init: clone the original Headers, then set the signature header.
    const retryHeaders = new Headers(init?.headers ?? undefined);
    retryHeaders.set('payment-signature', signed.headerValue);
    const retryInit: RequestInit = { ...(init ?? {}), headers: retryHeaders };

    let retryResponse: Response;
    try {
      retryResponse = await originalFetch(input, retryInit);
    } catch {
      // network failure on retry - surface the original 402 so the caller knows we tried.
      return response;
    }

    // best-effort settlement bookkeeping; never block the response on this.
    const paymentResponseHeaderB64 = retryResponse.headers.get('payment-response');
    if (paymentResponseHeaderB64) {
      void postToExtension({
        method: 'chromatika_x402_record_settlement',
        params: [
          {
            receiptId: signed.receiptId,
            paymentResponseHeaderB64,
          },
        ],
      }).catch(() => {
        /* settlement record is non-critical */
      });
    }

    return retryResponse;
  }

  // replace window.fetch in-place. Object.defineProperty so subsequent code still sees the wrap.
  Object.defineProperty(window, 'fetch', {
    value: chromatikaFetch,
    writable: true,
    configurable: true,
  });
}
