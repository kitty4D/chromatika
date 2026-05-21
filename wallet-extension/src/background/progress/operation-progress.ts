/**
 * background-side progress channel for slow / multi-step operations (ika sign, presign refill,
 * Solana confirm, etc.). the UI subscribes via `chrome.storage.onChanged` (see
 * `src/lib/use-operation-progress.ts`) and renders a sticky banner inside the wallet shell
 * (see `src/ui/components/OperationProgressBanner.tsx`).
 *
 * why `chrome.storage.session` and not the SharedWorker bus or a tRPC subscription:
 *   - SharedWorker bus is UI-to-UI only; the background SW does not connect to it.
 *   - `@trpc/client` over the chrome.runtime port is request/response (no server-push).
 *   - `chrome.storage.session.onChanged` is a real cross-context push channel that fires in
 *     popup, side panel, and any open extension page synchronously when storage updates.
 *
 * concurrency: one operation at a time per vault is the realistic ceiling (presigns serialize,
 * `runSerializedIkaTx` is mutexed). we model that with a single-slot record. beginning a new
 * operation while one is in-flight overwrites the slot: last writer wins.
 *
 * auto-clear: success and failure stamp `finishedAtMs` and schedule a 4s timer to wipe the
 * slot. the MV3 SW may die and lose the timer; on next SW wake, `endOperation` re-clears any
 * stale entry it sees with `finishedAtMs` older than ~10s.
 */
import { STORAGE_KEYS } from '@/background/storage';
import { maybeFireNotification } from '@/background/services/notifications/notify-chrome';

const STORAGE_KEY = STORAGE_KEYS.OP_PROGRESS_V1;

/**
 * recovery action surfaced on the banner. the UI dispatches by `kind`. discriminated union so
 * adding new actions is a drop-in addition without touching the banner's switch.
 */
export type OperationProgressAction =
  | { kind: 'recreate-ed25519-dwallet'; label: string; cluster: string }
  | { kind: 'recreate-secp256k1-dwallet'; label: string; cluster: string }
  | { kind: 'retry-team-funding'; label: string };

export type OperationProgress = {
  id: string;
  title: string;
  stage: string;
  stageMessage: string;
  startedAtMs: number;
  finishedAtMs?: number;
  error?: string;
  action?: OperationProgressAction;
};

let pendingClearTimer: ReturnType<typeof setTimeout> | null = null;

function newOpId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function writeProgress(value: OperationProgress | null): Promise<void> {
  try {
    if (value === null) {
      await chrome.storage.session.remove(STORAGE_KEY);
    } else {
      await chrome.storage.session.set({ [STORAGE_KEY]: value });
    }
  } catch (e) {
    console.warn('[op-progress] storage write failed', e);
  }
}

async function readProgress(): Promise<OperationProgress | null> {
  try {
    const r = await chrome.storage.session.get(STORAGE_KEY);
    const v = r?.[STORAGE_KEY];
    return (v ?? null) as OperationProgress | null;
  } catch {
    return null;
  }
}

function scheduleClear(id: string, delayMs: number): void {
  if (pendingClearTimer) clearTimeout(pendingClearTimer);
  pendingClearTimer = setTimeout(() => {
    pendingClearTimer = null;
    void (async () => {
      const cur = await readProgress();
      if (cur?.id === id) await writeProgress(null);
    })();
  }, delayMs);
}

/**
 * per-operation handle returned by `beginOperation`. pass it through the call chain so each
 * step can update the stage label without re-discovering the operation id.
 */
export type OperationHandle = {
  id: string;
  /** update the visible stage. `stageId` is the stable id (used for transitions); message is human copy. */
  updateStage(stageId: string, stageMessage: string): Promise<void>;
  /** mark the operation as succeeded. the banner stays visible briefly with a success affordance. */
  succeed(finalMessage?: string): Promise<void>;
  /**
   * mark the operation as failed. the banner shows the error and auto-clears after the grace
   * window. pass `opts.action` to attach a recovery affordance (button) to the banner; the UI
   * dispatches by `action.kind`.
   */
  fail(error: string, opts?: { action?: OperationProgressAction }): Promise<void>;
};

/**
 * drop-in shim used at call sites that don't actually want a banner (e.g. tests, headless paths).
 * every method is a no-op so callers can write `const op = beginOperation(...)` unconditionally.
 */
export const NOOP_OPERATION: OperationHandle = Object.freeze({
  id: 'noop',
  async updateStage() {},
  async succeed() {},
  async fail() {},
});

const SUCCESS_GRACE_MS = 2_500;
const FAILURE_GRACE_MS = 6_000;

export function beginOperation(title: string): OperationHandle {
  const id = newOpId();
  const startedAtMs = Date.now();
  // sweep any stale finished record before claiming the slot. avoids a flicker where the user
  // sees the previous "Signed ✓" affordance jump to the new operation's title with no transition.
  void (async () => {
    const cur = await readProgress();
    if (cur?.finishedAtMs && Date.now() - cur.finishedAtMs > 10_000) {
      await writeProgress(null);
    }
    await writeProgress({
      id,
      title,
      stage: 'starting',
      stageMessage: title,
      startedAtMs,
    });
  })();

  return {
    id,
    async updateStage(stageId, stageMessage) {
      const cur = await readProgress();
      // only update if we still own the slot. a newer operation wins.
      if (cur && cur.id !== id) return;
      await writeProgress({
        id,
        title,
        stage: stageId,
        stageMessage,
        startedAtMs,
      });
    },
    async succeed(finalMessage) {
      const cur = await readProgress();
      if (cur && cur.id !== id) return;
      const finishedAtMs = Date.now();
      await writeProgress({
        id,
        title,
        stage: 'succeeded',
        stageMessage: finalMessage ?? 'Done',
        startedAtMs,
        finishedAtMs,
      });
      const lcTitle = title.toLowerCase();
      if (lcTitle.includes('dwallet') || lcTitle.includes('dkg') || lcTitle.includes('sign') || lcTitle.includes('presign')) {
        void maybeFireNotification('ikaEvents', {
          id: `chromatika-ika-${id}`,
          title: finalMessage ?? 'Operation completed',
          message: title,
        });
      }
      scheduleClear(id, SUCCESS_GRACE_MS);
    },
    async fail(error, opts) {
      const cur = await readProgress();
      if (cur && cur.id !== id) return;
      const finishedAtMs = Date.now();
      await writeProgress({
        id,
        title,
        stage: 'failed',
        stageMessage: error,
        startedAtMs,
        finishedAtMs,
        error,
        ...(opts?.action ? { action: opts.action } : null),
      });
      const lcTitle = title.toLowerCase();
      if (lcTitle.includes('dwallet') || lcTitle.includes('dkg') || lcTitle.includes('sign') || lcTitle.includes('presign')) {
        void maybeFireNotification('ikaEvents', {
          id: `chromatika-ika-${id}`,
          title: 'Operation failed',
          message: `${title} - ${error}`,
        });
      }
      // banner with a recovery action stays visible until the user clicks or dismisses it; no
      // auto-clear so we don't disappear the affordance before they read it.
      if (!opts?.action) scheduleClear(id, FAILURE_GRACE_MS);
    },
  };
}

/**
 * update the visible stage on whatever operation is currently in flight, without needing to
 * thread an `OperationHandle` through every helper. useful for shared code (e.g.
 * `confirmSolanaTxByPolling`) that participates in many different parent operations and just
 * wants to surface its own progress when one is active.
 *
 * no-op when there is no in-flight operation, when the slot has already been marked
 * `succeeded` / `failed`, or when storage is unavailable.
 */
export async function updateCurrentOperationStage(stageId: string, stageMessage: string): Promise<void> {
  const cur = await readProgress();
  if (!cur || cur.finishedAtMs) return;
  await writeProgress({
    ...cur,
    stage: stageId,
    stageMessage,
  });
}

/** storage key exposed for the UI hook. */
export const OPERATION_PROGRESS_STORAGE_KEY = STORAGE_KEY;
