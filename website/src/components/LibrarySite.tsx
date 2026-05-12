import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import type { LibraryKind } from "../data/library-types";
import {
  getLibraryTitle,
  libraryDocExists,
  listLibraryNav,
  loadLibraryBody,
} from "../data/library-docs";
import { useDocHead } from "../lib/use-doc-head";
import { MarkdownDoc } from "./MarkdownDoc";

function LibrarySidebar({
  kind,
  activeSlug,
  basePath,
}: {
  kind: LibraryKind;
  activeSlug?: string;
  basePath: "/library/user" | "/library/tech";
}) {
  const label = kind === "user" ? "user guides" : "tech guides";
  return (
    <aside className="docs-sidebar library-sidebar" aria-label={label}>
      <p className="docs-sidebar-title">
        <Link to={basePath}>{label}</Link>
      </p>
      <nav className="docs-sidebar-scroll" aria-label={`${label} index`}>
        <ul className="docs-nav-list library-nav-list">
          {listLibraryNav(kind).map(({ slug, title }) => {
            const to = `${basePath}/${slug}`;
            const isActive = activeSlug === slug;
            return (
              <li key={slug}>
                <Link
                  to={to}
                  className={isActive ? "docs-nav-link docs-nav-link--active" : "docs-nav-link"}
                >
                  {title}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}

function LibraryShell({
  kind,
  basePath,
  activeSlug,
  children,
}: {
  kind: LibraryKind;
  basePath: "/library/user" | "/library/tech";
  activeSlug?: string;
  children: ReactNode;
}) {
  return (
    <div className="docs-layout library-layout">
      <LibrarySidebar kind={kind} activeSlug={activeSlug} basePath={basePath} />
      <div className="docs-main library-main">{children}</div>
    </div>
  );
}

export function LibraryHome() {
  useDocHead({
    title: "guides library",
    description:
      "Entry point for Chromatika markdown guides: user guides and tech guides indices. Prefer the top navigation for browsing.",
    canonicalPath: "/library",
  });
  return (
    <div className="page-library-hub page-library-hub--minimal">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">guides library</span>
      </nav>
      <header className="page-header">
        <h1>guides library</h1>
        <p className="page-lead">
          this URL stays for bookmarks. use the headers on other pages instead of linking here on
          purpose.
        </p>
      </header>
      <ul className="article-index tight library-minimal-links">
        <li>
          <Link to="/library/user/readme">user guides</Link>
        </li>
        <li>
          <Link to="/library/tech/readme">tech guides</Link>
        </li>
      </ul>
    </div>
  );
}

type LibraryBodyLoad =
  | { status: "loading" }
  | { status: "ready"; markdown: string }
  | { status: "missing" };

function LibraryDocPageInner({
  kind,
  basePath,
}: {
  kind: LibraryKind;
  basePath: "/library/user" | "/library/tech";
}) {
  const { slug } = useParams();
  const effective = (slug ?? "readme").toLowerCase();
  const exists = libraryDocExists(kind, effective);
  const title = exists ? getLibraryTitle(kind, effective) : undefined;
  const sectionLabel = kind === "user" ? "user guides" : "tech guides";

  useDocHead({
    title,
    description: title ? `${sectionLabel}: ${title} - chromatika library reference.` : undefined,
    canonicalPath: exists ? `${basePath}/${effective}` : undefined,
    jsonLd: title
      ? {
          "@context": "https://schema.org",
          "@type": "Article",
          headline: title,
          articleSection: sectionLabel,
          author: { "@type": "Organization", name: "Chromatika" },
          publisher: { "@type": "Organization", name: "Chromatika" },
        }
      : null,
  });

  const [load, setLoad] = useState<LibraryBodyLoad>(() =>
    exists ? { status: "loading" } : { status: "missing" },
  );

  useEffect(() => {
    if (!exists) {
      setLoad({ status: "missing" });
      return;
    }
    let cancelled = false;
    setLoad({ status: "loading" });
    void loadLibraryBody(kind, effective).then((markdown) => {
      if (cancelled) return;
      if (markdown === undefined) setLoad({ status: "missing" });
      else setLoad({ status: "ready", markdown });
    });
    return () => {
      cancelled = true;
    };
  }, [exists, kind, effective]);

  if (!exists) {
    return (
      <Navigate to={kind === "user" ? "/library/user/readme" : "/library/tech/readme"} replace />
    );
  }

  if (load.status === "loading") {
    return (
      <div className="route-fallback" aria-busy="true" aria-live="polite">
        loading guide...
      </div>
    );
  }

  if (load.status === "missing") {
    return (
      <Navigate to={kind === "user" ? "/library/user/readme" : "/library/tech/readme"} replace />
    );
  }

  const resolvedTitle = title!;
  const crumbLabel = sectionLabel;
  return (
    <article className="page-article library-article">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <span>guides library</span>
        <span aria-hidden="true">/</span>
        <Link to={basePath}>{crumbLabel}</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">{resolvedTitle}</span>
      </nav>
      <header className="article-header">
        <p className="article-eyebrow">{crumbLabel}</p>
        <h1>{resolvedTitle}</h1>
      </header>
      <MarkdownDoc markdown={load.markdown} />
    </article>
  );
}

export function LibraryUserDocPage() {
  const { slug } = useParams();
  const effective = (slug ?? "readme").toLowerCase();
  return (
    <LibraryShell kind="user" basePath="/library/user" activeSlug={effective}>
      <LibraryDocPageInner kind="user" basePath="/library/user" />
    </LibraryShell>
  );
}

export function LibraryTechDocPage() {
  const { slug } = useParams();
  const effective = (slug ?? "readme").toLowerCase();
  return (
    <LibraryShell kind="tech" basePath="/library/tech" activeSlug={effective}>
      <LibraryDocPageInner kind="tech" basePath="/library/tech" />
    </LibraryShell>
  );
}
