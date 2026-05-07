/**
 * Marketing iframe + static preview: wrap a control so it looks present but does not
 * activate. Same behavior as the drawer shortcuts on the landing preview.
 *
 * Optional `layout="block"` makes the wrapper full width (settings menu rows, send CTA).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

const HIDE_AFTER_MS = 2400;

type Props = {
  message: string;
  children: ReactNode;
  className?: string;
  /** `block` = full-width flex shell for `sp-menuRow` / `sp-btnFull` children */
  layout?: 'inline' | 'block';
};

export function PreviewDisabledTooltip({ message, children, className, layout = 'inline' }: Props) {
  const [open, setOpen] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const block = layout === 'block';

  const clearHide = useCallback(() => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const show = useCallback(
    (autoHide: boolean) => {
      clearHide();
      setOpen(true);
      if (autoHide) {
        hideTimer.current = window.setTimeout(() => {
          setOpen(false);
          hideTimer.current = null;
        }, HIDE_AFTER_MS);
      }
    },
    [clearHide],
  );

  const hide = useCallback(() => {
    clearHide();
    setOpen(false);
  }, [clearHide]);

  useEffect(() => () => clearHide(), [clearHide]);

  function intercept(e: MouseEvent | PointerEvent | KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    show(true);
  }

  const wrapperStyle: CSSProperties = block
    ? {
        position: 'relative',
        display: 'flex',
        width: '100%',
        minWidth: 0,
        cursor: 'not-allowed',
      }
    : {
        position: 'relative',
        display: 'inline-flex',
        cursor: 'not-allowed',
      };

  const childMaskStyle: CSSProperties = block
    ? {
        pointerEvents: 'none',
        opacity: 0.55,
        filter: 'saturate(0.85)',
        display: 'flex',
        width: '100%',
        minWidth: 0,
      }
    : {
        pointerEvents: 'none',
        opacity: 0.55,
        filter: 'saturate(0.85)',
        display: 'inline-flex',
      };

  const tooltipStyle: CSSProperties = {
    position: 'absolute',
    bottom: 'calc(100% + 8px)',
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'oklch(0.16 0.04 285)',
    color: 'oklch(0.94 0.02 260)',
    fontSize: '11px',
    fontWeight: 600,
    padding: '6px 10px',
    borderRadius: '8px',
    border: '1px solid oklch(0.55 0.08 260 / 0.5)',
    boxShadow: '0 6px 24px oklch(0.05 0.04 285 / 0.55)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    zIndex: 10000,
    letterSpacing: '0.01em',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    opacity: open ? 1 : 0,
    transition: 'opacity 120ms ease-out',
  };

  const caretStyle: CSSProperties = {
    position: 'absolute',
    top: '100%',
    left: '50%',
    transform: 'translateX(-50%)',
    width: 0,
    height: 0,
    borderLeft: '5px solid transparent',
    borderRight: '5px solid transparent',
    borderTop: '5px solid oklch(0.16 0.04 285)',
  };

  return (
    <span
      className={className}
      style={wrapperStyle}
      data-preview-disabled=""
      onClickCapture={intercept}
      onPointerDownCapture={intercept}
      onMouseDownCapture={intercept}
      onKeyDownCapture={(e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') intercept(e);
      }}
      onMouseEnter={() => show(false)}
      onMouseLeave={hide}
      onFocus={() => show(false)}
      onBlur={hide}
    >
      <span style={childMaskStyle}>{children}</span>
      <span role="tooltip" aria-hidden={!open} style={tooltipStyle}>
        {message}
        <span style={caretStyle} />
      </span>
    </span>
  );
}
