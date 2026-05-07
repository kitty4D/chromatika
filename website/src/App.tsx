import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { CodeCurrent } from "./components/CodeCurrent";
import { HomeHero } from "./components/HomeHero";
import { KnowledgeBaseHub } from "./components/KnowledgeBaseHub";
import { HeaderSearchButton, SearchModalProvider } from "./components/SearchModal";
import { SiteFooter } from "./components/SiteFooter";
import { WalletVaultPreview } from "./components/WalletVaultPreview";
import { homeIntroFullParagraph } from "./data/home-intro";
import { articleBySlug, articlesInCategory, kbCategories, type KbCategoryId } from "./data/kb";
import { useDocHead } from "./lib/use-doc-head";

const LibraryHome = lazy(() =>
  import("./components/LibrarySite").then((m) => ({ default: m.LibraryHome }))
);
const LibraryUserDocPage = lazy(() =>
  import("./components/LibrarySite").then((m) => ({ default: m.LibraryUserDocPage }))
);
const LibraryTechDocPage = lazy(() =>
  import("./components/LibrarySite").then((m) => ({ default: m.LibraryTechDocPage }))
);
const PrivacyPolicy = lazy(() =>
  import("./components/LegalPages").then((m) => ({ default: m.PrivacyPolicy }))
);
const TermsOfService = lazy(() =>
  import("./components/LegalPages").then((m) => ({ default: m.TermsOfService }))
);

function RouteFallback() {
  return (
    <div className="route-fallback" aria-live="polite">
      loading...
    </div>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 22 22"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      {open ? (
        <path
          d="M4 4l14 14M18 4L4 18"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M4 6h14M4 11h14M4 16h14"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function PrimaryNavLinks({ path, onNavigate }: { path: string; onNavigate?: () => void }) {
  const userGuidesActive = path.startsWith("/library/user");
  const techGuidesActive = path.startsWith("/library/tech");
  const isKbSurface =
    path === "/knowledge-base" || path.startsWith("/article/") || path.startsWith("/category/");
  return (
    <>
      <Link to="/" className={path === "/" ? "nav-link active" : "nav-link"} onClick={onNavigate}>
        home
      </Link>
      <Link
        to="/library/user/readme"
        className={userGuidesActive ? "nav-link active" : "nav-link"}
        onClick={onNavigate}
      >
        user guides
      </Link>
      <Link
        to="/library/tech/readme"
        className={techGuidesActive ? "nav-link active" : "nav-link"}
        onClick={onNavigate}
      >
        tech guides
      </Link>
      <Link
        to="/knowledge-base"
        className={isKbSurface ? "nav-link active" : "nav-link"}
        onClick={onNavigate}
      >
        knowledge base
      </Link>
    </>
  );
}

function Home() {
  useDocHead({
    canonicalPath: "/",
  });

  const homeMidDriftOptions = useMemo(
    () => ({
      count: 7,
      minLifespanSec: 12,
      maxLifespanSec: 22,
      peakOpacity: 0.2,
      maxBlurPx: 1,
      maxYawDeg: 5,
      maxZPx: 18,
      peakWidth: 0.07,
      bendWindow: 0.2,
      bandPaddingPx: 8,
      bandHeightPx: 12,
      colorCycleSec: 10,
      targetSelectors: [
        ".home-drift-band-between",
        ".home-drift-band-post-line",
        ".home-drift-viewport-left",
        ".home-drift-viewport-right",
      ],
    }),
    []
  );

  return (
    <div className="home">
      <HomeHero />

      <div className="home-mid-drift">
        <CodeCurrent options={homeMidDriftOptions}>
          <div className="home-drift-bleed">
            <div className="home-drift-viewport-left" aria-hidden="true" />
            <div className="home-drift-bleed-inner">
              <WalletVaultPreview />
              <div className="home-drift-band-between" aria-hidden="true" />
              <div className="home-guides-stack">
                <div className="home-drift-band-post-line" aria-hidden="true" />
                <div id="home-learn-more" className="home-learn-more-target" tabIndex={-1}>
                  <p className="home-learn-more-body">{homeIntroFullParagraph}</p>
                </div>
                <h2 className="home-guides-heading" id="home-guides-heading">
                  learn even more with these guides
                </h2>
                <section
                  className="guide-spot-row"
                  aria-labelledby="home-guides-heading"
                  aria-label="user and tech guide cards"
                >
                  <section className="guide-spot" aria-label="user guides">
                    <Link
                      to="/library/user/readme"
                      className="guide-spot-card guide-spot-card--user"
                    >
                      <h3 className="guide-spot-title">user guides</h3>
                      <p className="guide-spot-body">
                        task-style markdown reference: onboarding, vaults, dWallets, sends,
                        hardware, chains, and advanced surfaces. searchable from the header.
                      </p>
                      <span className="guide-spot-cta">browse tasks →</span>
                    </Link>
                  </section>
                  <section className="guide-spot" aria-label="tech guides">
                    <Link
                      to="/library/tech/readme"
                      className="guide-spot-card guide-spot-card--tech"
                    >
                      <div className="guide-spot-head">
                        <span className="guide-spot-kicker">docs · internals</span>
                        <h3 className="guide-spot-title">tech guides</h3>
                      </div>
                      <p className="guide-spot-body">
                        deep technical notes on how chromatika implements crypto, ika, the dapp
                        bridge, chrome APIs, and integrations. same markdown library, engineering
                        angle.
                      </p>
                      <span className="guide-spot-cta">read implementation notes →</span>
                    </Link>
                  </section>
                </section>
              </div>
            </div>
            <div className="home-drift-viewport-right" aria-hidden="true" />
          </div>
        </CodeCurrent>
      </div>
    </div>
  );
}

function CategoryPage() {
  const { categoryId } = useParams();
  const cat = kbCategories.find((c) => c.id === (categoryId as KbCategoryId));
  const list = cat ? articlesInCategory(cat.id) : [];

  useDocHead({
    title: cat?.label,
    description: cat?.blurb,
    canonicalPath: cat ? `/category/${cat.id}` : undefined,
  });

  if (!cat) {
    return <Navigate to="/knowledge-base" replace />;
  }

  return (
    <div className="page-category">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <Link to="/knowledge-base">knowledge base</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">{cat.label}</span>
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

  useDocHead({
    title: article?.title,
    description: article?.summary,
    canonicalPath: article ? `/article/${article.slug}` : undefined,
    jsonLd:
      article && cat
        ? {
            "@context": "https://schema.org",
            "@type": "Article",
            headline: article.title,
            description: article.summary,
            articleSection: cat.label,
            author: { "@type": "Organization", name: "Chromatika" },
            publisher: { "@type": "Organization", name: "Chromatika" },
          }
        : null,
  });

  if (!article || !cat) {
    return <Navigate to="/knowledge-base" replace />;
  }

  return (
    <article className="page-article">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <Link to="/knowledge-base">knowledge base</Link>
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
        <Link to="/knowledge-base" className="text-link">
          knowledge base home
        </Link>
      </footer>
    </article>
  );
}

function SiteChrome({ children }: { children: ReactNode }) {
  const location = useLocation();
  const path = location.pathname;
  const isLibrary = path.startsWith("/library");
  const isLegal = path.startsWith("/legal/");
  const isKbSurface =
    path === "/knowledge-base" || path.startsWith("/article/") || path.startsWith("/category/");
  const isDocs = isKbSurface || isLibrary || isLegal;

  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [path]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileNavOpen]);

  return (
    <div className={isDocs ? "site site--docs" : "site"}>
      <div className="bg-aurora" aria-hidden="true" />
      <header className={`site-header${mobileNavOpen ? " site-header--mobile-nav-open" : ""}`}>
        {mobileNavOpen ? (
          <div
            role="presentation"
            className="mobile-nav-backdrop"
            aria-hidden="true"
            onClick={() => setMobileNavOpen(false)}
          />
        ) : null}
        <div className="header-bleed">
          <div className="header-spectral" aria-hidden="true" />
          <div className="header-sweep" aria-hidden="true" />
          <div className="header-glass-stack">
            <div className="header-constrain header-top-bar">
              <Link to="/" className="header-bar-wordmark">
                <span className="header-bar-wordmark-text">chromatika</span>
              </Link>
              <div className="header-top-actions">
                <nav className="header-nav header-nav--desktop" aria-label="primary">
                  <PrimaryNavLinks path={path} />
                </nav>
                <button
                  type="button"
                  className="mobile-nav-toggle"
                  aria-label={mobileNavOpen ? "Close menu" : "Open menu"}
                  aria-expanded={mobileNavOpen}
                  aria-controls="primary-nav-mobile"
                  onClick={() => setMobileNavOpen((o) => !o)}
                >
                  <MenuIcon open={mobileNavOpen} />
                </button>
                <div className="header-toolbar">
                  <HeaderSearchButton />
                </div>
              </div>
            </div>
            <div
              id="primary-nav-mobile"
              className={`mobile-nav-sheet${mobileNavOpen ? " mobile-nav-sheet--open" : ""}`}
              aria-hidden={!mobileNavOpen}
            >
              <nav className="header-nav header-nav--sheet" aria-label="primary">
                <PrimaryNavLinks path={path} onNavigate={() => setMobileNavOpen(false)} />
              </nav>
            </div>
          </div>
        </div>
      </header>
      <main
        id="main"
        className={isKbSurface || isLibrary || isLegal ? "site-main site-main--guide" : "site-main"}
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
        path="/knowledge-base"
        element={
          <SiteChrome>
            <KnowledgeBaseHub />
          </SiteChrome>
        }
      />
      <Route path="/resources" element={<Navigate to="/knowledge-base" replace />} />
      <Route path="/guide" element={<Navigate to="/library/user/readme" replace />} />
      <Route path="/guide/:slug" element={<Navigate to="/library/user/readme" replace />} />
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
        path="/library"
        element={
          <SiteChrome>
            <Suspense fallback={<RouteFallback />}>
              <LibraryHome />
            </Suspense>
          </SiteChrome>
        }
      />
      <Route
        path="/library/user"
        element={
          <SiteChrome>
            <Suspense fallback={<RouteFallback />}>
              <LibraryUserDocPage />
            </Suspense>
          </SiteChrome>
        }
      />
      <Route
        path="/library/user/:slug"
        element={
          <SiteChrome>
            <Suspense fallback={<RouteFallback />}>
              <LibraryUserDocPage />
            </Suspense>
          </SiteChrome>
        }
      />
      <Route
        path="/library/tech"
        element={
          <SiteChrome>
            <Suspense fallback={<RouteFallback />}>
              <LibraryTechDocPage />
            </Suspense>
          </SiteChrome>
        }
      />
      <Route
        path="/library/tech/:slug"
        element={
          <SiteChrome>
            <Suspense fallback={<RouteFallback />}>
              <LibraryTechDocPage />
            </Suspense>
          </SiteChrome>
        }
      />
      <Route
        path="/legal/privacy"
        element={
          <SiteChrome>
            <Suspense fallback={<RouteFallback />}>
              <PrivacyPolicy />
            </Suspense>
          </SiteChrome>
        }
      />
      <Route
        path="/legal/terms"
        element={
          <SiteChrome>
            <Suspense fallback={<RouteFallback />}>
              <TermsOfService />
            </Suspense>
          </SiteChrome>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
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
