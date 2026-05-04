import type { ReactNode } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import { ArticleBlocks } from "./components/ArticleBlocks";
import { HomeHero } from "./components/HomeHero";
import { HeaderSearchButton, SearchModalProvider } from "./components/SearchModal";
import {
  LibraryHome,
  LibraryTechDocPage,
  LibraryUserDocPage,
} from "./components/LibrarySite";
import { PrivacyPolicy, TermsOfService } from "./components/LegalPages";
import { ResourcesHub } from "./components/ResourcesHub";
import { SiteFooter } from "./components/SiteFooter";
import { WalletVaultPreview } from "./components/WalletVaultPreview";
import {
  articleBySlug,
  articlesInCategory,
  kbArticles,
  kbCategories,
  type KbCategoryId,
} from "./data/kb";
import {
  guideArticleBySlug,
  guideArticlesInSection,
  guideSections,
  type GuideArticle,
  type GuideMediaSlot,
} from "./data/guide";

function GuideMediaStrip({ media }: { media: GuideMediaSlot[] }) {
  const items = media.filter((m) => m.src?.trim());
  if (items.length === 0) return null;

  return (
    <section className="guide-media" aria-label="screenshots and video">
      <h2 className="guide-media-heading">media</h2>
      <div className="guide-media-grid">
        {items.map((m, i) =>
          m.kind === "video" ? (
            <figure key={i} className="guide-media-figure">
              <video className="guide-media-video" controls preload="metadata" src={m.src} />
              {m.caption ? (
                <figcaption className="guide-media-caption">{m.caption}</figcaption>
              ) : null}
            </figure>
          ) : (
            <figure key={i} className="guide-media-figure">
              <img className="guide-media-img" src={m.src} alt={m.alt} loading="lazy" />
              {m.caption ? (
                <figcaption className="guide-media-caption">{m.caption}</figcaption>
              ) : null}
            </figure>
          )
        )}
      </div>
    </section>
  );
}

function Home() {
  return (
    <div className="home">
      <HomeHero />

      <WalletVaultPreview />

      <section className="guide-spot-row" aria-label="guides and resources">
        <section className="guide-spot" aria-label="user guide">
          <Link to="/guide" className="guide-spot-card">
            <h2 className="guide-spot-title">user guide</h2>
            <p className="guide-spot-body">
              step-by-step wallet tasks: onboarding, everyday use, advanced options, hardware.
              screenshots and clips stack here as we capture them.
            </p>
            <span className="guide-spot-cta">open the guide →</span>
          </Link>
        </section>
        <section className="guide-spot" aria-label="resource library">
          <Link to="/resources" className="guide-spot-card">
            <h2 className="guide-spot-title">resource library</h2>
            <p className="guide-spot-body">
              how the on-site KB and guide relate to optional user and tech guide markdown libraries
              you keep beside the extension in a developer checkout.
            </p>
            <span className="guide-spot-cta">browse layers →</span>
          </Link>
        </section>
      </section>

      <section className="grid-categories" aria-label="browse by category">
        {kbCategories.map((cat) => {
          const count = articlesInCategory(cat.id).length;
          return (
            <Link key={cat.id} className="cat-card" to={`/category/${cat.id}`}>
              <h2 className="cat-title">{cat.label}</h2>
              <p className="cat-blurb">{cat.blurb}</p>
              <span className="cat-meta">
                {count} article{count === 1 ? "" : "s"}
              </span>
            </Link>
          );
        })}
      </section>

      <section className="all-articles" aria-label="all articles">
        <h2 className="section-title">all articles</h2>
        <ul className="article-index">
          {kbArticles.map((a) => (
            <li key={a.slug}>
              <Link to={`/article/${a.slug}`} className="article-link">
                <span className="article-link-title">{a.title}</span>
                <span className="article-link-sum">{a.summary}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function CategoryPage() {
  const { categoryId } = useParams();
  const cat = kbCategories.find((c) => c.id === (categoryId as KbCategoryId));
  const list = cat ? articlesInCategory(cat.id) : [];

  if (!cat) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="page-category">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <span>{cat.label}</span>
      </nav>
      <header className="page-header">
        <h1>{cat.label}</h1>
        <p className="page-lead">{cat.blurb}</p>
      </header>
      <ul className="article-index tight">
        {list.map((a) => (
          <li key={a.slug}>
            <Link to={`/article/${a.slug}`} className="article-link">
              <span className="article-link-title">{a.title}</span>
              <span className="article-link-sum">{a.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ArticlePage() {
  const { slug } = useParams();
  const article = slug ? articleBySlug(slug) : undefined;
  const cat = article ? kbCategories.find((c) => c.id === article.categoryId) : undefined;

  if (!article || !cat) {
    return <Navigate to="/" replace />;
  }

  return (
    <article className="page-article">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <Link to={`/category/${article.categoryId}`}>{cat.label}</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">{article.title}</span>
      </nav>
      <header className="article-header">
        <p className="article-eyebrow">{cat.label}</p>
        <h1>{article.title}</h1>
        <p className="article-summary">{article.summary}</p>
      </header>
      <ArticleBlocks body={article.body} />
      <footer className="article-footer">
        <Link to={`/category/${article.categoryId}`} className="text-link">
          ← {cat.label}
        </Link>
        <Link to="/" className="text-link">
          all topics
        </Link>
      </footer>
    </article>
  );
}

function GuideSidebar({ activeSlug }: { activeSlug?: string }) {
  return (
    <aside className="docs-sidebar" aria-label="guide sections">
      <p className="docs-sidebar-title">
        <Link to="/guide">user guide</Link>
      </p>
      {guideSections.map((section) => {
        const pages = guideArticlesInSection(section.id);
        return (
          <div key={section.id} className="docs-nav-group">
            <h3 className="docs-nav-heading">{section.label}</h3>
            <ul className="docs-nav-list">
              {pages.map((p) => {
                const to = `/guide/${p.slug}`;
                const isActive = activeSlug === p.slug;
                return (
                  <li key={p.slug}>
                    <Link
                      to={to}
                      className={isActive ? "docs-nav-link docs-nav-link--active" : "docs-nav-link"}
                    >
                      {p.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </aside>
  );
}

function GuideShell({ activeSlug, children }: { activeSlug?: string; children: ReactNode }) {
  return (
    <div className="docs-layout">
      <GuideSidebar activeSlug={activeSlug} />
      <div className="docs-main">{children}</div>
    </div>
  );
}

function GuideHub() {
  return (
    <div className="guide-hub">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">user guide</span>
      </nav>
      <header className="page-header">
        <h1>user guide</h1>
        <p className="page-lead">
          task-based walkthroughs for Chromatika: onboarding, everyday flows, advanced toggles, and
          hardware paths. screenshots and video appear in each page as we capture them; assets live
          under <code className="inline-code">/guide/assets/</code>. search guide pages from the
          header.
        </p>
      </header>

      {guideSections.map((section) => {
        const pages = guideArticlesInSection(section.id);
        if (pages.length === 0) return null;
        return (
          <section key={section.id} className="guide-hub-section">
            <h2 className="guide-hub-section-title">{section.label}</h2>
            <p className="guide-hub-section-blurb">{section.blurb}</p>
            <ul className="article-index tight">
              {pages.map((a: GuideArticle) => (
                <li key={a.slug}>
                  <Link to={`/guide/${a.slug}`} className="article-link">
                    <span className="article-link-title">{a.title}</span>
                    <span className="article-link-sum">{a.summary}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function GuideArticlePage() {
  const { slug } = useParams();
  const article = slug ? guideArticleBySlug(slug) : undefined;
  const section = article ? guideSections.find((s) => s.id === article.sectionId) : undefined;

  if (!article || !section) {
    return <Navigate to="/guide" replace />;
  }

  return (
    <article className="page-article guide-article">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <Link to="/guide">user guide</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">{article.title}</span>
      </nav>
      <header className="article-header">
        <p className="article-eyebrow">{section.label}</p>
        <h1>{article.title}</h1>
        <p className="article-summary">{article.summary}</p>
        {article.lastUpdated ? (
          <p className="article-meta">
            <span className="article-meta-label">last updated</span>{" "}
            <time dateTime={article.lastUpdated}>{article.lastUpdated}</time>
          </p>
        ) : null}
      </header>
      <ArticleBlocks body={article.body} />
      {article.media && article.media.length > 0 ? <GuideMediaStrip media={article.media} /> : null}
      <footer className="article-footer">
        <Link to="/guide" className="text-link">
          ← user guide
        </Link>
      </footer>
    </article>
  );
}

function SiteChrome({ children }: { children: ReactNode }) {
  const location = useLocation();
  const isGuide = location.pathname.startsWith("/guide");
  const isLibrary = location.pathname.startsWith("/library");
  const isKbArticle =
    location.pathname.startsWith("/article/") || location.pathname.startsWith("/category/");
  const isDocs = isGuide || isKbArticle || isLibrary;

  return (
    <div className={isDocs ? "site site--docs" : "site"}>
      <div className="bg-aurora" aria-hidden="true" />
      <header className="site-header">
        <div className="header-bleed">
          <div className="header-spectral" aria-hidden="true" />
          <div className="header-sweep" aria-hidden="true" />
          <div className="header-glass-stack">
            <div className="header-constrain header-top-bar">
              <Link to="/" className="header-bar-wordmark">
                chromatika
              </Link>
              <div className="header-top-actions">
                <nav className="header-nav" aria-label="primary">
                  <Link
                    to="/"
                    className={location.pathname === "/" ? "nav-link active" : "nav-link"}
                  >
                    home
                  </Link>
                  <Link to="/guide" className={isGuide ? "nav-link active" : "nav-link"}>
                    user guide
                  </Link>
                  <Link
                    to="/resources"
                    className={location.pathname === "/resources" ? "nav-link active" : "nav-link"}
                  >
                    resources
                  </Link>
                  <Link
                    to="/library"
                    className={isLibrary ? "nav-link active" : "nav-link"}
                  >
                    library
                  </Link>
                  <Link to="/article/getting-help" className="nav-link">
                    knowledge base
                  </Link>
                </nav>
                <div className="header-toolbar">
                  <HeaderSearchButton />
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>
      <main
        id="main"
        className={
          isGuide || isLibrary ? "site-main site-main--guide" : "site-main"
        }
      >
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <SiteChrome>
            <Home />
          </SiteChrome>
        }
      />
      <Route
        path="/category/:categoryId"
        element={
          <SiteChrome>
            <CategoryPage />
          </SiteChrome>
        }
      />
      <Route
        path="/article/:slug"
        element={
          <SiteChrome>
            <ArticlePage />
          </SiteChrome>
        }
      />
      <Route
        path="/resources"
        element={
          <SiteChrome>
            <ResourcesHub />
          </SiteChrome>
        }
      />
      <Route
        path="/library"
        element={
          <SiteChrome>
            <LibraryHome />
          </SiteChrome>
        }
      />
      <Route
        path="/library/user"
        element={
          <SiteChrome>
            <LibraryUserDocPage />
          </SiteChrome>
        }
      />
      <Route
        path="/library/user/:slug"
        element={
          <SiteChrome>
            <LibraryUserDocPage />
          </SiteChrome>
        }
      />
      <Route
        path="/library/tech"
        element={
          <SiteChrome>
            <LibraryTechDocPage />
          </SiteChrome>
        }
      />
      <Route
        path="/library/tech/:slug"
        element={
          <SiteChrome>
            <LibraryTechDocPage />
          </SiteChrome>
        }
      />
      <Route
        path="/legal/privacy"
        element={
          <SiteChrome>
            <PrivacyPolicy />
          </SiteChrome>
        }
      />
      <Route
        path="/legal/terms"
        element={
          <SiteChrome>
            <TermsOfService />
          </SiteChrome>
        }
      />
      <Route
        path="/guide"
        element={
          <SiteChrome>
            <GuideShell>
              <GuideHub />
            </GuideShell>
          </SiteChrome>
        }
      />
      <Route
        path="/guide/:slug"
        element={
          <SiteChrome>
            <GuideArticleView />
          </SiteChrome>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function GuideArticleView() {
  const { slug } = useParams();
  return (
    <GuideShell activeSlug={slug}>
      <GuideArticlePage />
    </GuideShell>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SearchModalProvider>
        <AppRoutes />
      </SearchModalProvider>
    </BrowserRouter>
  );
}
