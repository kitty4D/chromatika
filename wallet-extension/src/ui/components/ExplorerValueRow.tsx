import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { truncateAddress, truncateAddressTail } from '@/lib/dwallet-ui-labels';

/**
 * truncated monospace value, optional explorer link, and copy-to-clipboard (always when copyLabel set).
 */
export function ExplorerValueRow({
  fullValue,
  href,
  truncateTail = 4,
  truncateMid,
  copyLabel,
  className = '',
  linkClassName = 'cd-explorerMonoLink',
}: {
  fullValue: string;
  href: string | null;
  truncateTail?: number;
  /** when set, uses head…tail truncation instead of tail-only. */
  truncateMid?: { head: number; tail: number };
  /** when set, shows copy button with this aria-label (e.g. "Copy dWallet object id"). */
  copyLabel: string;
  className?: string;
  /** class for the `<a>` when href is set (defaults to explorer-styled mono link). */
  linkClassName?: string;
}) {
  const [copied, setCopied] = useState(false);
  const display = truncateMid
    ? truncateAddress(fullValue, truncateMid.head, truncateMid.tail)
    : truncateAddressTail(fullValue, truncateTail);

  async function copy() {
    await navigator.clipboard.writeText(fullValue).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className={`ch-explorerValueRow ${className}`.trim()}>
      {href ? (
        <a
          className={linkClassName}
          href={href}
          target="_blank"
          rel="noreferrer"
          title={fullValue}
          onClick={(e) => e.stopPropagation()}
        >
          {display}
        </a>
      ) : (
        <span className="mono cd-explorerMonoPlain" title={fullValue}>
          {display}
        </span>
      )}
      <button
        type="button"
        className="ch-copyIconBtn ch-copyIconBtn--12"
        aria-label={copied ? 'Copied' : copyLabel}
        onClick={(e) => {
          e.stopPropagation();
          void copy();
        }}
      >
        {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2} />}
      </button>
      {/* transient confirmation: collapses to width 0 when not copied so layout stays stable */}
      <span
        role="status"
        aria-live="polite"
        aria-hidden={!copied}
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          color: 'rgba(134, 239, 172, 0.95)',
          marginLeft: copied ? 4 : 0,
          maxWidth: copied ? 80 : 0,
          overflow: 'hidden',
          opacity: copied ? 1 : 0,
          whiteSpace: 'nowrap',
          transition: 'opacity 0.2s ease, max-width 0.2s ease, margin-left 0.2s ease',
          pointerEvents: 'none',
        }}
      >
        copied
      </span>
    </div>
  );
}
