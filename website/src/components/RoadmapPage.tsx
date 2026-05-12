import { Link } from "react-router-dom";
import {
  roadmapFeatured,
  roadmapLastReviewed,
  roadmapLegend,
  roadmapSections,
  roadmapShipped,
  type RoadmapItem,
  type RoadmapLink,
  type RoadmapStatus,
} from "../data/roadmap-data";
import { useDocHead } from "../lib/use-doc-head";

function statusClass(s: RoadmapStatus): string {
  return `roadmap-badge roadmap-badge--${s}`;
}

function RoadmapLinkEl({ link }: { link: RoadmapLink }) {
  const external = link.href.startsWith("http");
  if (external) {
    return (
      <a className="roadmap-item-link" href={link.href} target="_blank" rel="noopener noreferrer">
        {link.label}
      </a>
    );
  }
  return (
    <Link className="roadmap-item-link" to={link.href}>
      {link.label}
    </Link>
  );
}

function RoadmapItemCard({ item, featured }: { item: RoadmapItem; featured?: boolean }) {
  return (
    <article className={featured ? "roadmap-card roadmap-card--featured" : "roadmap-card"}>
      <div className="roadmap-card-top">
        <span className={statusClass(item.status)}>{item.status.replace(/-/g, " ")}</span>
        <h3 className="roadmap-card-title">{item.title}</h3>
        <p className="roadmap-card-tagline">{item.tagline}</p>
      </div>
      <p className="roadmap-card-body">{item.body}</p>
      {item.links && item.links.length > 0 ? (
        <div className="roadmap-card-links">
          {item.links.map((l) => (
            <RoadmapLinkEl key={l.href + l.label} link={l} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function RoadmapPage() {
  useDocHead({
    title: "roadmap",
    description:
      "where chromatika is headed next: recovery, on-chain guardrails on every curve, Seeker-native surfaces, encrypt.xyz depth, agents, and UX — honest status badges, no dated promises.",
    canonicalPath: "/roadmap",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: "Chromatika roadmap",
      description: "Product-facing roadmap with status legend and shipped history.",
    },
  });

  return (
    <div className="roadmap-page">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">roadmap</span>
      </nav>

      <header className="roadmap-hero">
        <p className="roadmap-hero-eyebrow">product direction</p>
        <h1 className="roadmap-hero-title">roadmap</h1>
        <p className="roadmap-hero-lead">
          where the wallet is going next. tldr: recovery you can&apos;t lose, on-chain guardrails on
          every curve, and dWallets that follow you off the desktop.
        </p>
        <p className="roadmap-hero-meta">
          living document · last reviewed {roadmapLastReviewed}. engineering truth lives in the repo
          under{" "}
          <a
            href="https://github.com/kitty4D/chromatika/blob/main/wallet-extension/docs/STATUS.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            STATUS.md
          </a>{" "}
          and{" "}
          <a
            href="https://github.com/kitty4D/chromatika/blob/main/wallet-extension/docs/CHANGELOG.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            CHANGELOG.md
          </a>
          . nothing here is a dated promise — badges carry the weight.
        </p>
      </header>

      <section className="roadmap-legend" aria-labelledby="roadmap-legend-heading">
        <h2 id="roadmap-legend-heading" className="roadmap-section-title">
          status legend
        </h2>
        <ul className="roadmap-legend-grid">
          {roadmapLegend.map((row) => (
            <li key={row.status} className="roadmap-legend-item">
              <span className={statusClass(row.status)}>{row.status.replace(/-/g, " ")}</span>
              <span className="roadmap-legend-blurb">{row.blurb}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="roadmap-featured-zone" aria-labelledby="roadmap-featured-heading">
        <div className="roadmap-featured-head">
          <h2 id="roadmap-featured-heading" className="roadmap-section-title roadmap-section-title--xl">
            featured
          </h2>
          <p className="roadmap-section-sub">
            the three themes we&apos;re most excited to ship next — each repeats in its lane below.
          </p>
        </div>
        <div className="roadmap-featured-cards">
          {roadmapFeatured.map((item, i) => (
            <div
              key={item.id}
              className="roadmap-featured-wrap"
              style={{ ["--roadmap-stagger" as string]: `${i * 70}ms` }}
            >
              <div className="roadmap-featured-ribbon" aria-hidden />
              <RoadmapItemCard item={item} featured />
            </div>
          ))}
        </div>
      </section>

      {roadmapSections.map((section) => (
        <section key={section.id} className="roadmap-section" aria-labelledby={`sec-${section.id}`}>
          <h2 id={`sec-${section.id}`} className="roadmap-section-title">
            {section.label}
          </h2>
          <div className="roadmap-section-grid">
            {section.items.map((item) => (
              <RoadmapItemCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      ))}

      <section className="roadmap-shipped" aria-labelledby="roadmap-shipped-heading">
        <h2 id="roadmap-shipped-heading" className="roadmap-section-title">
          shipped recently
        </h2>
        <p className="roadmap-shipped-intro">
          rolling tail of user-visible ships. between major changelog headings we sometimes split a dense week into
          calendar-day slices so the rail stays readable; source of truth is always{" "}
          <a
            href="https://github.com/kitty4D/chromatika/blob/main/wallet-extension/docs/CHANGELOG.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            CHANGELOG.md
          </a>
          .
        </p>
        <ol className="roadmap-shipped-list">
          {roadmapShipped.map((row) => (
            <li key={row.date + row.title} className="roadmap-shipped-row">
              <time className="roadmap-shipped-date" dateTime={row.date}>
                {row.date}
              </time>
              <div className="roadmap-shipped-copy">
                <span className="roadmap-shipped-title">{row.title}</span>
                <span className="roadmap-shipped-detail">{row.detail}</span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <footer className="roadmap-footer-links">
        <Link to="/knowledge-base" className="text-link">
          knowledge base
        </Link>
        <Link to="/library/user/readme" className="text-link">
          user guides
        </Link>
        <Link to="/tutorial" className="text-link">
          hands-on tutorial
        </Link>
      </footer>
    </div>
  );
}
