# x402 spending caps + receipt log

chromatika gates every x402 payment through **daily USD spending caps** (per-counterparty + global) and persists a **receipt log** of the most recent 200 payments. caps reset at local-timezone midnight. receipts track status transitions from `pending` to `settled` / `failed` / `rejected` and let users flag good / bad payments for future allowlist seeding.

## storage

```jsonc
chrome.storage.local["chromatika_x402_caps_v1"] = {
  "perCounterpartyDailyCapUsd": {                        // Map<host, capUsd>
    "api.example.com": 10,
    "api.openai.com": 50
  },
  "globalDailyCapUsd": 25,                               // total spend cap across all hosts
  "defaultPerCounterpartyDailyCapUsd": 5                 // applied to first-seen hosts
}

chrome.storage.local["chromatika_x402_receipts_v1"] = [
  {
    "id": "<uuid>",
    "host": "api.example.com",
    "amountUsd": 0.10,
    "status": "settled",                                 // 'pending' | 'settled' | 'failed' | 'rejected'
    "txHash": "<base58 solana sig>",
    "error": null,
    "quality": "good",                                   // 'good' | 'bad' | null
    "createdAtMs": 1700000000000,
    "settledAtMs": 1700000000500,
    "callerHint": { "url": "https://api.example.com/v1/...", "method": "GET" }
  },
  // ... up to 200 entries, oldest dropped on overflow
]
```

## the cap check (pre-popup, synchronous)

```ts
async function wouldExceedCaps(host: string, amountUsd: number): Promise<{
  exceeded: boolean,
  perHostSpentUsd: number,
  globalSpentUsd: number,
  perHostCapUsd: number | null,
  globalCapUsd: number | null,
}> {
  const caps = await readCaps();
  const receipts = await readReceipts();

  const todayStart = startOfLocalDay();
  const todayReceipts = receipts.filter(r =>
    r.createdAtMs >= todayStart && (r.status === 'pending' || r.status === 'settled')
    // failed / rejected receipts don't count against budget
  );

  const perHostSpent = todayReceipts
    .filter(r => r.host === host)
    .reduce((sum, r) => sum + r.amountUsd, 0);
  const globalSpent = todayReceipts.reduce((sum, r) => sum + r.amountUsd, 0);

  const perHostCap = caps.perCounterpartyDailyCapUsd[host]
    ?? caps.defaultPerCounterpartyDailyCapUsd
    ?? Infinity;
  const globalCap = caps.globalDailyCapUsd ?? Infinity;

  const exceeded = (perHostSpent + amountUsd > perHostCap) || (globalSpent + amountUsd > globalCap);
  return { exceeded, perHostSpent, globalSpent, perHostCap, globalCap };
}
```

key behaviors:
- runs **synchronously before** opening the approval popup. if exceeded, no popup → no user attention wasted
- pending payments count against the budget (so a user can't approve 10 payments simultaneously hoping they all squeeze in - the second one sees the first as pending)
- failed / rejected payments **don't** count
- per-host check uses the explicit per-host cap, falling back to the default-for-new-hosts (`defaultPerCounterpartyDailyCapUsd`)
- global check is independent - even if a host has unlimited cap, the global total still gates
- `null` cap = unlimited

## defaults

```ts
const DEFAULT_PER_COUNTERPARTY_DAILY_CAP_USD = 5;
const DEFAULT_GLOBAL_DAILY_CAP_USD = 25;
```

new install starts with `$5/seller` and `$25 total/day` budgets. user can adjust via:
- `x402SetPerCounterpartyCap({ host, capUsd | null })` - set or clear per-host
- `x402SetGlobalCap({ capUsd | null })` - set or clear global
- `x402SetDefaultCap({ capUsd })` - default for new hosts

## the day-bucket boundary

```ts
function startOfLocalDay(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
}
```

local timezone, midnight. a payment at 11:59 pm and one at 12:00 am are in **different day buckets** even though they're back-to-back. by design - users plan budgets in their local day, not UTC.

if the user travels timezones, the boundary shifts with them. one minor edge case: a user who flies west at midnight could see two "fresh" daily budgets in 24 hours. acceptable for a budget feature; if it ever becomes an issue, swap to UTC.

## receipt creation

```ts
async function recordPaymentInitiated(host, amountUsd, callerHint): Promise<string> {
  const receipts = await readReceipts();
  const id = crypto.randomUUID();
  receipts.unshift({
    id,
    host,
    amountUsd,
    status: 'pending',
    txHash: null,
    error: null,
    quality: null,
    createdAtMs: Date.now(),
    settledAtMs: null,
    callerHint,
  });
  // cap at 200 most recent
  if (receipts.length > 200) receipts.length = 200;
  await chrome.storage.local.set({ chromatika_x402_receipts_v1: receipts });
  return id;
}
```

receipts are **prepended** (newest first). once the array hits 200, oldest entries are dropped via `length = 200` truncation.

## status transitions

```
created → 'pending'   (signed, not yet seen settlement)
'pending' → 'settled' (payment-response received with tx hash)
'pending' → 'failed'  (payment-response indicated error, e.g. tx didn't land)
'pending' → 'rejected' (user canceled before signing - actually 'rejected' is set at the dispatcher, no receipt change here typically)
```

`settled` is the happy path. `failed` means the server rejected after we signed (rare but possible). `rejected` means user clicked cancel on the popup.

## settlement update

`x402-fetch-wrapper.ts` watches the retry response for `payment-response` header. when present:

```ts
chrome.runtime.sendMessage({
  type: 'chromatika_x402_record_settlement',
  receiptId,
  paymentResponseHeaderB64,
});
```

background:
```ts
async function recordX402Settlement(receiptId, paymentResponseHeaderB64) {
  const decoded = decodePaymentResponseHeader(paymentResponseHeaderB64);
  // { scheme, chain, txHash, settledAt, amountSettled }
  await updateReceipt(receiptId, {
    status: decoded.txHash ? 'settled' : 'failed',
    txHash: decoded.txHash,
    settledAtMs: decoded.settledAt * 1000,
  });
}
```

fire-and-forget from the page side; non-blocking on the dapp. if the settlement record fails (network blip), the receipt stays `pending` - users can manually clear or wait for the next time the page makes a payment to the same host.

## the quality flag

```ts
async function setReceiptQuality(id, quality: 'good' | 'bad' | null) {
  await updateReceipt(id, { quality });
}
```

users mark thumbs-up / thumbs-down on receipts. the data is stored locally; future surfaces could:
- auto-allowlist hosts with high thumbs-up ratio (raise their cap automatically)
- auto-blocklist hosts with thumbs-down (set their cap to 0)
- aggregate across users (privacy-preserving) for community blocklists

today the flag is **just stored**. no automated action. user-driven curation only.

## the listing surface

`x402ListReceipts({ limit?: 1-200 })` returns receipts in newest-first order. used by the receipts UI for display.

`x402GetCaps()` returns the full caps state plus today's spend per host + global. used by the caps UI for display.

## tRPC procedure list

| procedure | what |
|-----------|------|
| `x402GetCaps` | returns caps + today's spend |
| `x402SetPerCounterpartyCap({ host, capUsd \| null })` | set / clear per-host cap |
| `x402SetGlobalCap({ capUsd \| null })` | set / clear global cap |
| `x402SetDefaultCap({ capUsd })` | default for new hosts |
| `x402ListReceipts({ limit })` | list receipts |
| `x402SetReceiptQuality({ id, quality })` | thumbs-up/down |
| `x402QuoteAndSign(...)` | dispatcher entry from fetch interception (not user-facing) |
| `getPendingX402Request({ id })` | popup reads pending request |
| `approvePendingX402({ id })` | popup approves, signing happens |
| `rejectPendingX402({ id, reason })` | popup rejects |
| `x402RecordSettlement({ receiptId, paymentResponseHeaderB64 })` | page-side settlement update |

## library

- `chrome.storage.local` for caps + receipts persistence
- internal: `wallet-extension/src/background/x402/x402-caps.ts`
- internal: `wallet-extension/src/background/x402/x402-receipts.ts`

## related

- [x402-fetch-interception.md](/library/tech/x402-fetch-interception) - where `wouldExceedCaps` is called
- [x402-spec-svm-exact.md](/library/tech/x402-spec-svm-exact) - the wire format
- [x402-solana-tx-build.md](/library/tech/x402-solana-tx-build) - what gets signed (after caps approve)
