// shared glossary chip - wraps a piece of jargon (e.g. "dWallet Vault", "fee payer")
// and reveals a small popover on click/focus with a plain-english definition. used
// across onboarding, send, settings, and any screen that has to surface a chromatika
// term that a metamask / phantom refugee wouldn't recognize yet.
//
// the implementation is intentionally tiny: no portal, no positioning library, just
// a `<details>`-like toggle that pops the explanation underneath the chip. enough
// for the in-extension popup / side panel where space is tight.

import { useCallback, useEffect, useRef, useState } from 'react';

export function GlossaryTerm({
  term,
  definition,
  href,
  children,
}: {
  /** the short label shown in the popover header (e.g. "dWallet Vault"). */
  term: string;
  /** 1-3 sentence plain-english definition. shown verbatim. */
  definition: string;
  /** optional "learn more" link rendered as a small footer in the popover. */
  href?: string;
  /** the inline text rendered inside the chip - usually the term itself, but can
   *  override (e.g. "this dWallet" referring back to a "dWallet" term). */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // close on outside click - small enough that useOnClickOutside would be overkill.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent): void {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener('mousedown', onDocClick);
    return () => window.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <span ref={wrapRef} className="cd-glossary">
      <button
        type="button"
        className="cd-glossary-chip"
        aria-expanded={open}
        aria-label={`${term} - explain`}
        onClick={toggle}
      >
        <span className="cd-glossary-chipLabel">{children ?? term}</span>
        <span className="cd-glossary-chipMark" aria-hidden>
          ?
        </span>
      </button>
      {open ? (
        <span className="cd-glossary-pop" role="tooltip">
          <span className="cd-glossary-popTitle">{term}</span>
          <span className="cd-glossary-popBody">{definition}</span>
          {href ? (
            <a
              className="cd-glossary-popLink"
              href={href}
              target="_blank"
              rel="noreferrer"
            >
              learn more
            </a>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
