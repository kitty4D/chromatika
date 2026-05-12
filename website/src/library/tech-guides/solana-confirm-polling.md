# Solana confirm-by-polling

polling-based replacement for `@solana/web3.js@1.x` `Connection.confirmTransaction(...)`. used everywhere in the MV3 service worker that needs to wait for a Solana transaction to land.

## why not websockets

`@solana/web3.js@1.x` `confirmTransaction` opens a websocket subscription via `rpc-websockets`. in the MV3 service worker, the browser-targeted bundle references `window` (`new Rge` at `index.browser.mjs`), which is undefined in a SW. the subscribe fails, the 30s timeout fires with `"Transaction was not confirmed in 30.00 seconds"`, and cleanup throws `ReferenceError: window is not defined`.

polling `getSignatureStatus` is pure HTTP. works identically in the popup, side panel, and service worker. tradeoff: small per-poll round-trip cost (1s interval default) instead of push notifications.

## API

```ts
async function confirmSolanaTxByPolling(
  connection: Connection,
  signature: string,
  options?: ConfirmSolanaTxOptions,
): Promise<void>;
```

### options

| option | default | description |
|--------|---------|-------------|
| `commitment` | `'confirmed'` | minimum commitment level (`processed` / `confirmed` / `finalized`) |
| `timeoutMs` | `60_000` | total time before giving up |
| `intervalMs` | `1_000` | poll interval between status checks |
| `progressLabel` | - | when set, pushes a stage update into the operation-progress banner |
| `progressStageId` | `'solana-confirm'` | stable id for the progress stage |

## commitment ranking

```ts
const COMMITMENT_RANK = { processed: 0, confirmed: 1, finalized: 2 };
```

the poll resolves when `getSignatureStatus` returns a `confirmationStatus` whose rank is >= the required rank. this means requesting `'confirmed'` also resolves if the tx reaches `'finalized'` before the next poll.

## error handling

- **tx failed on chain:** throws immediately with `"Solana tx <sig> failed: <err>"` (no waiting for timeout)
- **timeout:** throws with `"Solana tx <sig> not <commitment> after Ns. Check Solana Explorer or CLI for final status."`
- `searchTransactionHistory: false` on every poll (we just submitted; no need to search old blocks)

## integration with operation-progress

when `progressLabel` is set, calls `updateCurrentOperationStage(stageId, label)` at the start of the wait. this updates whatever parent operation is in flight (e.g. "Signing Solana transaction" -> "Confirming on Solana...") without needing the `OperationHandle` threaded through.

## call sites

all Solana confirm paths route through this function:
- native SOL send
- SPL token send
- pc-token flows
- ika `approve_message` (gRPC fee payment)
- fee-payer top-up / drain

**never** call `connection.confirmTransaction(...)` directly in the service worker.

## files

- `src/background/chains/solana-confirm.ts` - the polling implementation
- `src/background/progress/operation-progress.ts` - `updateCurrentOperationStage`

## related

- [operation-progress-banner.md](/library/tech/operation-progress-banner) - the banner system this feeds into
- [solana-tx-sign.md](/library/tech/solana-tx-sign) - signing flow that calls this for confirmation
