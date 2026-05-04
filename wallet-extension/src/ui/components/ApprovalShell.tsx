import type { CSSProperties, ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * shared scaffold for popup approval surfaces (dapp connect / sign, tx send, mcp sign,
 * x402 payment, hardware sign). owns the form wrapper, title row, optional origin sub-line,
 * and the approve / reject button footer so every popup looks and feels the same.
 *
 * the body content (`children`) is left to the screen because the per-flow detail rows vary
 * a lot (gas pickers, simulation previews, choice selectors, etc.).
 *
 * design constraints baked in:
 *   - submit-on-Enter triggers approve, but only when not busy and not disabled. matches the
 *     pre-existing tx-approval / dapp-approval behavior so muscle memory carries over.
 *   - reject is always reachable: button stays clickable while busy unless `lockReject` is set
 *     (use sparingly - a stuck "approving..." with no escape is the worst possible UX).
 *   - `busy` swaps the approve label to a working spinner-style indicator and disables submit.
 *   - error block sits above the footer so it's the last thing the user sees before the
 *     buttons. green "done" messages use the `success` slot, which behaves the same way.
 *
 * optional header chrome:
 *   - `icon` renders a lucide icon (or any ReactNode) before the title. use it to anchor flows
 *     that benefit from a visual category (Lock for agent signing, CreditCard for x402, etc).
 *   - `showClose` adds an X close button at the top-right that triggers `onReject`. use it on
 *     popups where rejecting via the button row would otherwise force users to scroll to it.
 */
export function ApprovalShell({
  title,
  icon,
  showClose = false,
  origin,
  originLabel = 'from',
  children,
  error,
  success,
  busy = false,
  approveDisabled = false,
  approveLabel = 'approve',
  busyLabel = 'working…',
  rejectLabel = 'reject',
  lockReject = false,
  onApprove,
  onReject,
}: {
  /** required title displayed in the popup header. lowercase, short, action-oriented. */
  title: string;
  /** optional icon or other React node to render before the title (e.g. `<Lock size={18} />`). */
  icon?: ReactNode;
  /** when true, show a small X close button top-right that calls `onReject`. */
  showClose?: boolean;
  /** optional origin / context line ("from foo.com"). hidden when not provided. */
  origin?: string;
  /** override the leading word for the origin row. defaults to "from". */
  originLabel?: string;
  /** form body content (per-flow rows, sim previews, etc.). */
  children: ReactNode;
  /** error message shown above the footer. red text. cleared by the caller. */
  error?: string | null;
  /** green confirmation message shown above the footer. usually a tx hash/digest. */
  success?: ReactNode;
  /** disables submit + flips the approve button label to `busyLabel` while pending. */
  busy?: boolean;
  /** disables submit even when not busy (e.g. validation pending, choice not made). */
  approveDisabled?: boolean;
  /** override the approve button label. defaults to "approve". */
  approveLabel?: string;
  /** label shown on the approve button while `busy` is true. */
  busyLabel?: string;
  /** override the reject button label. defaults to "reject". */
  rejectLabel?: string;
  /** disable reject during `busy`. only set this when canceling mid-sign would be unsafe. */
  lockReject?: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <form
      className="wc-approvalSheet"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && !approveDisabled) onApprove();
      }}
    >
      <div className="wc-titleRow" style={titleRow}>
        <div className="wc-title" style={titleInner}>
          {icon && (
            <span aria-hidden="true" style={iconWrap}>
              {icon}
            </span>
          )}
          <span>{title}</span>
        </div>
        {showClose && (
          <button
            type="button"
            onClick={onReject}
            aria-label={rejectLabel}
            disabled={lockReject && busy}
            style={closeBtn}
          >
            <X size={16} />
          </button>
        )}
      </div>

      {origin && (
        <div style={originRow}>
          {originLabel}{' '}
          <strong style={{ color: 'rgba(234,240,255,0.85)' }}>{origin}</strong>
        </div>
      )}

      {children}

      {error && <p style={errorText}>{error}</p>}
      {success && <div style={successText}>{success}</div>}

      <div className="wc-subgrid">
        <button
          type="submit"
          className="wc-btn wc-btnPrimary"
          style={{ flex: 1 }}
          disabled={busy || approveDisabled}
        >
          {busy ? busyLabel : approveLabel}
        </button>
        <button
          type="button"
          className="wc-btn"
          style={{ flex: 1 }}
          onClick={onReject}
          disabled={lockReject && busy}
        >
          {rejectLabel}
        </button>
      </div>
    </form>
  );
}

const titleRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};

const titleInner: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  flex: 1,
};

const iconWrap: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  color: 'rgba(165,180,252,0.95)',
  flexShrink: 0,
};

const closeBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'rgba(234,240,255,0.6)',
  cursor: 'pointer',
  padding: 4,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
  flexShrink: 0,
};

const originRow: CSSProperties = {
  fontSize: 11,
  color: 'rgba(234,240,255,0.55)',
  marginBottom: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};

const errorText: CSSProperties = {
  color: 'rgba(255,99,132,0.95)',
  fontSize: 13,
  margin: '0 0 10px 0',
  wordBreak: 'break-word',
};

const successText: CSSProperties = {
  color: 'rgba(16,185,129,0.95)',
  fontSize: 12,
  margin: '0 0 10px 0',
  wordBreak: 'break-all',
};
