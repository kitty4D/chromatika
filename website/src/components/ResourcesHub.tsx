import { Link } from "react-router-dom";

/** how KB, user guide, and bundled markdown libraries fit together. */
export function ResourcesHub() {
  return (
    <div className="page-resources">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">resource library</span>
      </nav>
      <header className="page-header">
        <h1>resource library</h1>
        <p className="page-lead">
          four surfaces: themed KB articles, the in-app-style user guide, and the full user + tech
          markdown stacks rendered under <Link to="/library">/library</Link>.
        </p>
      </header>

      <section className="resources-section" aria-labelledby="resources-on-site">
        <h2 id="resources-on-site" className="resources-section-title">
          on this site
        </h2>
        <ul className="resources-cards resources-cards--triple">
          <li>
            <Link to="/category/start" className="resources-card">
              <span className="resources-card-kicker">browse</span>
              <span className="resources-card-title">knowledge base</span>
              <span className="resources-card-body">
                short articles by theme: start here, identity, security, chains, hardware, product
                status. good first stop for humans and for copy that stays close to shipped
                behavior.
              </span>
            </Link>
          </li>
          <li>
            <Link to="/guide" className="resources-card">
              <span className="resources-card-kicker">walkthroughs</span>
              <span className="resources-card-title">user guide</span>
              <span className="resources-card-body">
                task-based pages with room for screenshots and clips. aimed at onboarding and
                everyday flows rather than protocol archaeology.
              </span>
            </Link>
          </li>
          <li>
            <Link to="/library" className="resources-card">
              <span className="resources-card-kicker">reference</span>
              <span className="resources-card-title">markdown library</span>
              <span className="resources-card-body">
                exhaustive user-facing feature reference plus deep technical notes, as authored in
                markdown with working internal links.
              </span>
            </Link>
          </li>
        </ul>
      </section>

      <section className="resources-section" aria-labelledby="resources-local">
        <h2 id="resources-local" className="resources-section-title">
          maintaining the markdown stacks
        </h2>
        <p className="resources-prose">
          sources of truth for those pages live under{" "}
          <code className="inline-code">website/src/library/</code> in-repo (user + tech
          directories). they are website-only: the extension bundle does not ship this prose.
        </p>
        <div className="resources-dual">
          <div className="resources-dual-card">
            <h3 className="resources-dual-title">user guides</h3>
            <p className="resources-prose">
              high-level how-to for <strong>what</strong> the wallet can do: prerequisites, steps,
              and options per feature, without leaning on specific UI chrome.
            </p>
            <p className="resources-prose resources-prose--muted">
              <Link to="/library/user/readme">open user guide index →</Link>
            </p>
          </div>
          <div className="resources-dual-card">
            <h3 className="resources-dual-title">tech guides</h3>
            <p className="resources-prose">
              deep-tech notes for <strong>how</strong> chromatika implements things: bytes, KDF
              envelopes, ika flows, bridge validation, and service boundaries.
            </p>
            <p className="resources-prose resources-prose--muted">
              <Link to="/library/tech/readme">open tech guide index →</Link>
            </p>
          </div>
        </div>
        <p className="resources-prose">
          after replacing <code className="inline-code">.md</code> files, run{" "}
          <code className="inline-code">pnpm run sync:library</code> so sibling links stay mapped to{" "}
          <code className="inline-code">/library/…</code> routes. keep pre-release and Solana ika
          disclaimers aligned with{" "}
          <code className="inline-code">wallet-extension/docs/STATUS.md</code>.
        </p>
      </section>
    </div>
  );
}
