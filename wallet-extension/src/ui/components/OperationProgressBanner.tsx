/**
 * sticky compact banner that shows what's currently running in the background. fed by
 * `useOperationProgress` (which reads `chrome.storage.session` and subscribes to changes), so
 * any background flow that calls `beginOperation()` from
 * `@/background/progress/operation-progress` will surface here without per-page wiring.
 *
 * three visual states:
 *   - `running`  : indigo-ish strip + animated spinner + elapsed seconds counter
 *   - `succeeded`: green strip + check, auto-dismisses after the background's grace window
 *   - `failed`   : red strip + alert icon. without an action it auto-dismisses after the grace
 *                  window; with an action (e.g. `recreate-ed25519-dwallet`) it sticks until the
 *                  user clicks the affordance or dismisses, since auto-disappearing a recovery
 *                  prompt would be hostile.
 *
 * mounted in `MainWalletShell` next to `AlertBanner` (between the dWallet context bar and the
 * scrollable content track) so it's visible on every tab without crowding the nav. the shell
 * passes `onAction` so the banner doesn't need to know how navigation works.
 */

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, AlertTriangle, Loader2, X } from 'lucide-react';
import { useOperationProgress } from '@/lib/use-operation-progress';
import {
  OPERATION_PROGRESS_STORAGE_KEY,
  type OperationProgress,
  type OperationProgressAction,
} from '@/background/progress/operation-progress';

const STAGE_RUNNING_TINT = { bg: 'var(--theme-banner-running-bg)', fg: 'var(--theme-banner-running-fg)' };
const STAGE_SUCCESS_TINT = { bg: 'var(--theme-banner-success-bg)', fg: 'var(--theme-banner-success-fg)' };
const STAGE_FAILURE_TINT = { bg: 'var(--theme-banner-error-bg)', fg: 'var(--theme-banner-error-fg)' };

function formatElapsed(ms: number): string {
  if (ms < 1_000) return '0s';
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

async function clearStoredProgress(): Promise<void> {
  try {
    await chrome.storage.session.remove(OPERATION_PROGRESS_STORAGE_KEY);
  } catch { /* session storage unavailable - silent fallback */ }
}

export type OperationProgressBannerProps = {
  /**
   * called when the user clicks an action affordance (e.g. "Recreate dWallet"). the banner
   * clears the stored slot before invoking; the host decides where to navigate. when omitted,
   * action buttons clear the slot but don't navigate.
   */
  onAction?: (action: OperationProgressAction) => void;
};

export function OperationProgressBanner({ onAction }: OperationProgressBannerProps = {}) {
  const progress = useOperationProgress();
  const [now, setNow] = useState(Date.now());

  // keep the elapsed-time read fresh while the operation is running. tick every 500ms so the
  // UI feels live without flooring at whole seconds, and stop the timer once the op finishes.
  useEffect(() => {
    if (!progress || progress.finishedAtMs) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [progress?.id, progress?.finishedAtMs]);

  const visible = progress != null;

  return (
    <AnimatePresence>
      {visible && progress != null ? (
        <motion.div
          key={progress.id}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          role="status"
          aria-live="polite"
          style={bannerWrapperStyle(progress)}
        >
          <BannerContents progress={progress} now={now} onAction={onAction} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function BannerContents({
  progress,
  now,
  onAction,
}: {
  progress: OperationProgress;
  now: number;
  onAction?: (action: OperationProgressAction) => void;
}) {
  const isFailed = progress.stage === 'failed';
  const isSucceeded = progress.stage === 'succeeded';
  const tint = isFailed
    ? STAGE_FAILURE_TINT
    : isSucceeded
      ? STAGE_SUCCESS_TINT
      : STAGE_RUNNING_TINT;
  const Icon = isFailed
    ? AlertTriangle
    : isSucceeded
      ? CheckCircle2
      : Loader2;
  const elapsed = (progress.finishedAtMs ?? now) - progress.startedAtMs;

  const isRunning = !isSucceeded && !isFailed;
  const action = progress.action;

  const handleAction = async () => {
    if (!action) return;
    await clearStoredProgress();
    onAction?.(action);
  };

  const handleDismiss = async () => {
    await clearStoredProgress();
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' }}>
      <motion.span
        style={{ display: 'inline-flex', color: tint.fg, flexShrink: 0 }}
        animate={isRunning ? { rotate: 360 } : { rotate: 0 }}
        transition={isRunning ? { duration: 1, repeat: Infinity, ease: 'linear' } : { duration: 0 }}
      >
        <Icon size={16} />
      </motion.span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: tint.fg, lineHeight: 1.2 }}>
          {progress.title}
        </div>
        <div
          style={{
            fontSize: 11,
            color: tint.fg,
            opacity: 0.85,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            lineHeight: 1.3,
          }}
          title={progress.stageMessage}
        >
          {progress.stageMessage}
        </div>
      </div>
      {action ? (
        <button
          type="button"
          onClick={handleAction}
          style={{
            background: 'rgba(0, 0, 0, 0.22)',
            border: `1px solid ${tint.fg}`,
            color: tint.fg,
            fontSize: 11,
            fontWeight: 600,
            padding: '4px 10px',
            borderRadius: 6,
            cursor: 'pointer',
            flexShrink: 0,
            letterSpacing: 0.2,
          }}
        >
          {action.label}
        </button>
      ) : null}
      {!isRunning ? (
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss"
          style={{
            background: 'transparent',
            border: 'none',
            color: tint.fg,
            opacity: 0.6,
            cursor: 'pointer',
            display: 'inline-flex',
            padding: 2,
            flexShrink: 0,
          }}
        >
          <X size={14} />
        </button>
      ) : (
        <div
          style={{
            fontSize: 11,
            color: tint.fg,
            opacity: 0.7,
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          {formatElapsed(elapsed)}
        </div>
      )}
    </div>
  );
}

function bannerWrapperStyle(progress: OperationProgress): React.CSSProperties {
  const tint = progress.stage === 'failed'
    ? STAGE_FAILURE_TINT
    : progress.stage === 'succeeded'
      ? STAGE_SUCCESS_TINT
      : STAGE_RUNNING_TINT;
  return {
    background: tint.bg,
    borderBottom: `1px solid ${tint.bg}`,
    overflow: 'hidden',
  };
}
