# x402 fetch interception (`x402-fetch-wrapper.ts`)

every page chromatika injects into gets a `window.fetch` wrapper that watches for `HTTP 402 + payment-required` responses. on detection, the wrapper hands the encoded payment-required header to the chromatika background, awaits user approval + signing, and retries the original request with `payment-signature` header. failure modes (cap exceeded, user rejected, signing error) surface the original 402 unchanged so explicit dapp 402 handlers still work.

## installation

`inject.ts` (the page-script injected by the content script in every frame) installs the wrapper:

```ts
import { installX402FetchWrapper } from './x402-fetch-wrapper';
installX402FetchWrapper();
```

happens at page load, **before** any dapp code runs (content script `run_at: 'document_start'`). by the time dapps reach for `window.fetch`, our wrapper is already in place.

## the wrapper

```ts
function installX402FetchWrapper() {
  const originalFetch = window.fetch;

  window.fetch = async function wrappedFetch(input, init) {
    const response = await originalFetch.call(this, input, init);

    // not a 402 - pass through unchanged
    if (response.status !== 402) return response;

    const paymentRequiredHeader = response.headers.get('payment-required');
    if (!paymentRequiredHeader) return response;   // 402 without our header - dapp's own 402

    // we have an x402-shaped 402. hand off to chromatika
    let paymentSignatureHeader: string | null;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'chromatika_x402_handle_402',
        paymentRequiredHeaderB64: paymentRequiredHeader,
        callerHint: { url: input.toString(), method: init?.method ?? 'GET' },
      });
      if (!result?.ok) {
        // user rejected, cap exceeded, signing failed - return the original 402
        // so the dapp can fall back to its own logic
        return response;
      }
      paymentSignatureHeader = result.paymentSignatureHeaderB64;
    } catch (e) {
      // chromatika unreachable, content script disconnected, etc.
      return response;
    }

    // retry with payment-signature
    const newInit = { ...(init ?? {}), headers: {
      ...((init?.headers as any) ?? {}),
      'payment-signature': paymentSignatureHeader,
    } };
    const retryResponse = await originalFetch.call(this, input, newInit);

    // optionally record settlement
    const paymentResponseHeader = retryResponse.headers.get('payment-response');
    if (paymentResponseHeader && result.receiptId) {
      void chrome.runtime.sendMessage({
        type: 'chromatika_x402_record_settlement',
        receiptId: result.receiptId,
        paymentResponseHeaderB64: paymentResponseHeader,
      });
    }

    return retryResponse;
  };
}
```

key invariants:
- non-402 responses pass through unchanged
- 402s without our `payment-required` header pass through unchanged (some dapps return 402 for their own reasons)
- chromatika failure modes return the **original 402** so the page can fall back to whatever it would normally do
- only the **first** retry happens. if the retry returns another 402, we don't loop - that goes back to the page

## the message types

extension message bus (chrome.runtime.sendMessage):

- `chromatika_x402_handle_402`: page → background. carries the `payment-required` header bytes and caller hint. background runs cap check, opens popup, signs via ika MPC or WC, returns `{ ok, paymentSignatureHeaderB64, receiptId }` or `{ ok: false, reason }`
- `chromatika_x402_record_settlement`: page → background. fire-and-forget. updates the receipt status from `pending` to `settled` with the on-chain tx hash from `payment-response`

these route through the existing dapp-bridge port; no new transport.

## the dispatcher

`x402-dispatch.ts` in the background handles `chromatika_x402_handle_402`:

```ts
async function dispatchX402(paymentRequiredHeaderB64, callerHint) {
  // 1. decode + validate
  const requirements = decodePaymentRequiredHeader(paymentRequiredHeaderB64);
  if (requirements.scheme !== 'exact') return { ok: false, reason: 'unsupported scheme' };
  if (requirements.chain !== 'solana') return { ok: false, reason: 'unsupported chain' };
  if (requirements.asset !== USDC_MINT) return { ok: false, reason: 'unsupported asset' };
  if (Date.now() / 1000 > requirements.deadline) return { ok: false, reason: 'expired' };

  // 2. cap check (synchronous, pre-popup)
  const host = new URL(callerHint.url).host;
  const amountUsd = requirements.amount / 1e6;   // 6 decimals
  const capCheck = await wouldExceedCaps(host, amountUsd);
  if (capCheck.exceeded) return { ok: false, reason: 'cap-exceeded', detail: capCheck };

  // 3. enqueue + open approval popup
  const requestId = randomUUID();
  await x402PendingQueue.enqueue({ id: requestId, requirements, host, amountUsd, callerHint });
  chrome.windows.create({
    url: chrome.runtime.getURL(`index.html?x402approve=${requestId}`),
    type: 'popup', width: 400, height: 700,
  });

  // 4. await user resolution
  const outcome = await x402PendingQueue.awaitResolve(requestId);
  if (outcome.kind !== 'approved') return { ok: false, reason: outcome.reason };

  // 5. dispatch to right signer
  const session = await getSession();
  const signedHeader = session.solanaWcAccount
    ? await x402WalletConnectSign(requirements, callerHint, session.solanaWcAccount)
    : await x402SolanaIkaSign(requirements, callerHint, session.activeDwallet);

  // 6. record receipt as 'pending' (will flip to 'settled' on payment-response)
  const receiptId = await x402Receipts.create({ host, amountUsd, status: 'pending', ... });

  return { ok: true, paymentSignatureHeaderB64: signedHeader, receiptId };
}
```

## why pre-popup cap check

`wouldExceedCaps(host, amountUsd)` runs synchronously **before** opening the approval popup. if the user is over their daily limit:
- popup never opens
- user doesn't waste attention on a request that would be rejected anyway
- dapp gets the 402 back, can degrade gracefully (offer a cheaper tier, ask user to top up cap, etc.)

caps reset at local-timezone midnight. see [x402-caps-receipts.md](/library/tech/x402-caps-receipts).

## the failure-pass-through philosophy

if anything goes wrong on chromatika's side - cap exceeded, user closed popup, signing crashed, ika network down, WC session expired - the wrapper returns the **original 402** to the page. this means:
- explicit dapp 402 handlers (e.g. `if (resp.status === 402) showPayWall(resp)`) keep working
- dapps that built their own non-x402 payment flow on top of 402 are unaffected
- chromatika is opt-in at the **wallet** layer, not at the dapp layer

contrast with: chromatika returning a 200 with chromatika-shaped error JSON, which would break dapps. the wrapper is intentionally minimal.

## what the wrapper does **not** do

- doesn't wrap XHR (XMLHttpRequest). dapps using XHR for 402-aware endpoints don't get the integration. modern dapps use fetch
- doesn't wrap `node-fetch` or other server-side HTTP clients - this is a browser-only wrapper, in the page world
- doesn't auto-retry on transient failures - one shot at signing + retry, then back to the dapp
- doesn't aggregate multiple 402s into a single approval - each 402 is a separate user-approval popup. for high-frequency callers, future could batch (with explicit consent)

## library

- `chrome.runtime.sendMessage` for page → background message
- internal: `inject.ts` for the install hook
- internal: `x402-fetch-wrapper.ts` for the wrapper itself

## related

- [x402-spec-svm-exact.md](/library/tech/x402-spec-svm-exact) - what `payment-required` / `payment-signature` look like
- [x402-solana-tx-build.md](/library/tech/x402-solana-tx-build) - how the signed tx gets constructed
- [x402-caps-receipts.md](/library/tech/x402-caps-receipts) - the cap check + receipt logging
