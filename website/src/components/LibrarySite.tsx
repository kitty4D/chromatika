import { Link, Navigate, useParams } from "react-router-dom";
import type { LibraryKind } from "../data/library-docs";
import {
  getLibraryBody,
  getLibraryTitle,
  libraryDocExists,
  listLibraryNav,
} from "../data/library-docs";
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
  children: React.ReactNode;
}) {
  return (
    <div className="docs-layout library-layout">
      <LibrarySidebar kind={kind} activeSlug={activeSlug} basePath={basePath} />
      <div className="docs-main library-main">{children}</div>
    </div>
  );
}

export function LibraryHome() {
  return (
    <div className="page-library-hub">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">library</span>
      </nav>
      <header className="page-header">
        <h1>markdown library</h1>
        <p className="page-lead">
          full-length reference docs maintained next to development: task-style user coverage and
          deep technical notes. start from each index or jump in from search.
        </p>
      </header>
      <ul className="resources-cards">
        <li>
          <Link to="/library/user/readme" className="resources-card">
            <span className="resources-card-kicker">index + pages</span>
            <span className="resources-card-title">user guides</span>
            <span className="resources-card-body">
              what the wallet supports per feature: prerequisites, steps, options (no UI
              wireframes).
            </span>
          </Link>
        </li>
        <li>
          <Link to="/library/tech/readme" className="resources-card">
            <span className="resources-card-kicker">index + pages</span>
            <span className="resources-card-title">tech guides</span>
            <span className="resources-card-body">
              how chromatika implements flows: crypto, ika, bridge, chrome APIs, integrations.
            </span>
          </Link>
        </li>
      </ul>
      <p className="resources-prose">
        contributors: drop updated <code className="inline-code">.md</code> files into{" "}
        <code className="inline-code">src/library/</code>, then run{" "}
        <code className="inline-code">pnpm run sync:library</code> so in-doc links stay routable.
      </p>
    </div>
  );
}

function LibraryDocPageInner({ kind, basePath }: { kind: LibraryKind; basePath: "/library/user" | "/library/tech" }) {
  const { slug } = useParams();
  const effective = (slug ?? "readme").toLowerCase();
  if (!libraryDocExists(kind, effective)) {
    return <Navigate to={kind === "user" ? "/library/user/readme" : "/library/tech/readme"} replace />;
  }
  const title = getLibraryTitle(kind, effective)!;
  const body = getLibraryBody(kind, effective)!;
  const crumbLabel = kind === "user" ? "user guides" : "tech guides";
  return (
    <article className="page-article library-article">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <Link to="/library">library</Link>
        <span aria-hidden="true">/</span>
        <Link to={basePath}>{crumbLabel}</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">{title}</span>
      </nav>
      <header className="article-header">
        <p className="article-eyebrow">{crumbLabel}</p>
        <h1>{title}</h1>
      </header>
      <MarkdownDoc markdown={body} />
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
