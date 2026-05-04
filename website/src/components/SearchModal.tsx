import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { kbArticles } from "../data/kb";
import { guideArticles } from "../data/guide";

import { filterLibrarySearch } from "../data/library-docs";

export type SearchResultItem =
  | { kind: "kb"; slug: string; title: string; summary: string; href: string }
  | { kind: "guide"; slug: string; title: string; summary: string; href: string }
  | { kind: "lib-user" | "lib-tech"; slug: string; title: string; summary: string; href: string };

function matches(needle: string, title: string, summary: string, slug: string): boolean {
  return (
    title.toLowerCase().includes(needle) ||
    summary.toLowerCase().includes(needle) ||
    slug.toLowerCase().includes(needle)
  );
}

export function filterSiteSearch(needle: string): SearchResultItem[] {
  const n = needle.trim().toLowerCase();
  if (!n) return [];
  const kb: SearchResultItem[] = kbArticles
    .filter((a) => matches(n, a.title, a.summary, a.slug))
    .map((a) => ({
      kind: "kb",
      slug: a.slug,
      title: a.title,
      summary: a.summary,
      href: `/article/${a.slug}`,
    }));
  const gu: SearchResultItem[] = guideArticles
    .filter((a) => matches(n, a.title, a.summary, a.slug))
    .map((a) => ({
      kind: "guide",
      slug: a.slug,
      title: a.title,
      summary: a.summary,
      href: `/guide/${a.slug}`,
    }));
  const lib = filterLibrarySearch(needle).map((h) => ({
    kind: h.kind,
    slug: h.slug,
    title: h.title,
    summary: h.summary,
    href: h.href,
  })) as SearchResultItem[];
  return [...kb, ...gu, ...lib];
}

type SearchModalCtx = {
  openSearch: () => void;
  closeSearch: () => void;
  isOpen: boolean;
};

const SearchModalContext = createContext<SearchModalCtx | null>(null);

export function useSiteSearch(): SearchModalCtx {
  const v = useContext(SearchModalContext);
  if (!v) {
    throw new Error("useSiteSearch must be used within SearchModalProvider");
  }
  return v;
}

export function SearchModalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openSearch = useCallback(() => setOpen(true), []);
  const closeSearch = useCallback(() => setOpen(false), []);

  const value = useMemo(
    () => ({
      openSearch,
      closeSearch,
      isOpen: open,
    }),
    [open, openSearch, closeSearch]
  );

  return (
    <SearchModalContext.Provider value={value}>
      {children}
      <SearchModalDialog open={open} onClose={closeSearch} />
    </SearchModalContext.Provider>
  );
}

function SearchGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="m16 16 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SearchModalDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reactId = useId();
  const titleId = `${reactId}-search-title`;
  const inputId = `${reactId}-search-input`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const results = useMemo(() => filterSiteSearch(q), [q]);

  useEffect(() => {
    if (!open) {
      setQ("");
      return;
    }
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="search-modal-root">
      <button
        type="button"
        className="search-modal-backdrop"
        onClick={onClose}
        aria-label="close search"
      />
      <div
        className="search-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="search-modal-header">
          <h2 id={titleId} className="search-modal-title">
            search
          </h2>
          <button type="button" className="search-modal-close" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>
        <label htmlFor={inputId} className="visually-hidden">
          search knowledge base, guide, and markdown library
        </label>
        <input
          id={inputId}
          ref={inputRef}
          type="search"
          className="search-modal-input"
          placeholder="articles, guides, library pages…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
        />
        <ul className="search-modal-results" aria-label="search results">
          {!q.trim() && (
            <li className="search-modal-empty">
              type to search the knowledge base, user guide, and markdown library.
            </li>
          )}
          {q.trim() && results.length === 0 && (
            <li className="search-modal-empty">no matches. try another word.</li>
          )}
          {results.map((r) => (
            <li key={`${r.kind}-${r.slug}`}>
              <Link to={r.href} className="search-modal-hit" onClick={() => onClose()}>
                <span className="search-modal-hit-badge">
                  {r.kind === "kb"
                    ? "kb"
                    : r.kind === "guide"
                      ? "guide"
                      : r.kind === "lib-user"
                        ? "user md"
                        : "tech md"}
                </span>
                <span className="search-modal-hit-title">{r.title}</span>
                <span className="search-modal-hit-sum">{r.summary}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function HeaderSearchButton() {
  const { openSearch } = useSiteSearch();
  return (
    <button
      type="button"
      className="header-search-btn"
      onClick={openSearch}
      aria-label="Open site search"
    >
      <SearchGlyph />
    </button>
  );
}
