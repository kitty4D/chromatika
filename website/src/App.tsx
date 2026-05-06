import { lazy, Suspense, type ReactNode } from "react";
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
import { KnowledgeBaseHub } from "./components/KnowledgeBaseHub";
import { HeaderSearchButton, SearchModalProvider } from "./components/SearchModal";
import { SiteFooter } from "./components/SiteFooter";
import { WalletVaultPreview } from "./components/WalletVaultPreview";
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

function Home() {
  useDocHead({
    canonicalPath: "/",
  });
  return (
    <div className="home">
      <HomeHero />

      <WalletVaultPreview />

      <section className="guide-spot-row" aria-label="guides">
        <section className="guide-spot" aria-label="user guides">
          <Link to="/library/user/readme" className="guide-spot-card">
            <h2 className="guide-spot-title">user guides</h2>
            <p className="guide-spot-body">
              task-style markdown reference: onboarding, vaults, dWallets, sends, hardware, chains,
              and advanced surfaces. searchable from the header.
            </p>
            <span className="guide-spot-cta">open user guides →</span>
          </Link>
        </section>
        <section className="guide-spot" aria-label="tech guides">
          <Link to="/library/tech/readme" className="guide-spot-card">
            <h2 className="guide-spot-title">tech guides</h2>
            <p className="guide-spot-body">
              deep technical notes on how chromatika implements crypto, ika, the dapp bridge, chrome
              APIs, and integrations. same markdown library, engineering angle.
            </p>
            <span className="guide-spot-cta">open tech guides →</span>
          </Link>
        </section>
      </section>
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
  const isKbSurface =
    path === "/knowledge-base" || path.startsWith("/article/") || path.startsWith("/category/");
  const isDocs = isKbSurface || isLibrary;

  const userGuidesActive = path.startsWith("/library/user");
  const techGuidesActive = path.startsWith("/library/tech");

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
                  <Link to="/" className={path === "/" ? "nav-link active" : "nav-link"}>
                    home
                  </Link>
                  <Link
                    to="/library/user/readme"
                    className={userGuidesActive ? "nav-link active" : "nav-link"}
                  >
                    user guides
                  </Link>
                  <Link
                    to="/library/tech/readme"
                    className={techGuidesActive ? "nav-link active" : "nav-link"}
                  >
                    tech guides
                  </Link>
                  <Link
                    to="/knowledge-base"
                    className={isKbSurface ? "nav-link active" : "nav-link"}
                  >
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
        className={isKbSurface || isLibrary ? "site-main site-main--guide" : "site-main"}
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
