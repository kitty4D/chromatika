import { Link } from "react-router-dom";
import { articlesInCategory, kbArticles, kbCategories } from "../data/kb";
import { useDocHead } from "../lib/use-doc-head";

/** Full index for `/article/*` and `/category/*`; linked from nav as "knowledge base". */
export function KnowledgeBaseHub() {
  useDocHead({
    title: "knowledge base",
    description:
      "Short themed articles on Chromatika: onboarding, identity, vault security, chains, hardware, and product status.",
    canonicalPath: "/knowledge-base",
  });

  return (
    <div className="home knowledge-base-hub">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">knowledge base</span>
      </nav>
      <header className="page-header">
        <h1>knowledge base</h1>
        <p className="page-lead">
          short articles grouped by theme. deeper task reference lives in{" "}
          <Link to="/library/user/readme">user guides</Link> (markdown); implementation notes in{" "}
          <Link to="/library/tech/readme">tech guides</Link>.
        </p>
      </header>

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

      <section className="all-articles" aria-label="all knowledge base articles">
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
