/// <reference lib="webworker" />
/**
 * unused MV3 placeholder (not referenced by manifest or vite entries).
 * popup to side panel sync uses [`shared/wallet-state-worker.ts`](./shared/wallet-state-worker.ts) instead.
 * kept as a no-op reserved file; safe to delete if you prefer zero dead workers.
 */
const _ctx: SharedWorkerGlobalScope = self as unknown as SharedWorkerGlobalScope;
_ctx.addEventListener('connect', () => {
  /* reserved */
});
