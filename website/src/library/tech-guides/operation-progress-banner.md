# operation-progress banner

background-side progress channel for long-running operations (ika sign, presign refill, Solana confirm, etc.). the UI subscribes via `chrome.storage.onChanged` and renders a sticky banner inside the wallet shell.

## why `chrome.storage.session`

the alternatives don't work:
- **SharedWorker bus** is UI-to-UI only; the background SW does not connect to it
- **tRPC over `chrome.runtime` port** is request/response (no server-push)
- **`chrome.storage.session.onChanged`** is a real cross-context push channel that fires synchronously in popup, side panel, and any open extension page

## data model

single-slot record at `chromatika_op_progress_v1` in `chrome.storage.session`:

```ts
type OperationProgress = {
  id: string;          // crypto.randomUUID()
  title: string;       // human-visible operation name
  stage: string;       // stable id for transitions ('starting' | 'solana-confirm' | 'succeeded' | 'failed' | ...)
  stageMessage: string; // human copy shown in the banner
  startedAtMs: number;
  finishedAtMs?: number;
  error?: string;
  action?: OperationProgressAction;
};
```

## recovery actions

`OperationProgressAction` is a discriminated union on `kind`:

- `recreate-ed25519-dwallet` - opens dWallet management for ED25519 re-DKG (post-devnet-wipe)
- `recreate-secp256k1-dwallet` - same for SECP256K1
- `retry-team-funding` - retries auto-funder request

banners with an action do **not** auto-clear (hostile to disappear a recovery prompt before the user reads it). dismissed via X or by clicking the action.

## lifecycle

### begin

```ts
const op = beginOperation('Signing EVM transaction');
```

writes the slot immediately. sweeps stale finished records (>10s old) before claiming.

### update stage

```ts
await op.updateStage('building-tx', 'Building transaction...');
```

only updates if `op.id` still owns the slot (newer operation wins).

### succeed

```ts
await op.succeed('Signed');
```

stamps `finishedAtMs`, schedules auto-clear after **2.5s**.

### fail

```ts
await op.fail('Network error', {
  action: { kind: 'recreate-ed25519-dwallet', label: 'Recreate dWallet', cluster: 'devnet' },
});
```

stamps `finishedAtMs`, schedules auto-clear after **6s** (unless an action is attached, then no auto-clear).

### headless / test paths

`NOOP_OPERATION` is a frozen no-op handle for call sites that don't want a banner.

### global stage update

```ts
await updateCurrentOperationStage('solana-confirm', 'Confirming on Solana...');
```

updates whatever operation is in flight without needing the handle. no-op when there is no active operation or the slot is already finished. used by shared code like `confirmSolanaTxByPolling`.

## concurrency

one operation at a time per vault is the realistic ceiling (presigns serialize, `runSerializedIkaTx` is mutexed). single-slot record, last writer wins.

## SW death recovery

the MV3 SW may die and lose the `setTimeout` for auto-clear. on next SW wake, `beginOperation` re-clears any stale entry with `finishedAtMs` older than ~10s.

## UI side

- **hook:** `useOperationProgress` (`src/lib/use-operation-progress.ts`) - subscribes to `chrome.storage.onChanged`
- **component:** `OperationProgressBanner` (`src/ui/components/OperationProgressBanner.tsx`) - mounted in `MainWalletShell` next to `AlertBanner`
- **action dispatch:** `MainWalletShell`'s `onAction` switch handles each `OperationProgressAction.kind`

## files

- `src/background/progress/operation-progress.ts` - core service
- `src/lib/use-operation-progress.ts` - UI hook
- `src/ui/components/OperationProgressBanner.tsx` - banner component

## related

- [solana-confirm-polling.md](/library/tech/solana-confirm-polling) - uses `updateCurrentOperationStage` for confirm progress
- [ika-sign-flow.md](/library/tech/ika-sign-flow) - wraps signing in `beginOperation`
- [ika-presign-pool-impl.md](/library/tech/ika-presign-pool-impl) - wraps refill in `beginOperation`
