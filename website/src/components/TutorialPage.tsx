import { Link } from "react-router-dom";
import {
  tutorialInstallCommands,
  tutorialLead,
  tutorialPreRelease,
  tutorialQuickRef,
  tutorialSteps,
} from "../data/tutorial-data";
import { useDocHead } from "../lib/use-doc-head";

export function TutorialPage() {
  useDocHead({
    title: "hands-on tutorial",
    description:
      "Visual getting-started tour: install from source, create a vault, navigate home, dWallets, sends, assets, activity, staking, x402, Policy Vault, MCP, and Chroma lab.",
    canonicalPath: "/tutorial",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: "Chromatika getting started tutorial",
      description: tutorialLead,
    },
  });

  return (
    <div className="tutorial-page">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">tutorial</span>
      </nav>

      <header className="tutorial-hero">
        <p className="tutorial-hero-eyebrow">hands-on</p>
        <h1 className="tutorial-hero-title">getting started</h1>
        <p className="tutorial-hero-lead">{tutorialLead}</p>
        <aside className="tutorial-callout" role="note">
          <strong>pre-release:</strong> {tutorialPreRelease}
        </aside>
      </header>

      <section className="tutorial-install" aria-labelledby="tutorial-install-heading">
        <h2 id="tutorial-install-heading" className="tutorial-section-title">
          1 · installation
        </h2>
        <p className="tutorial-p">
          chromatika is a Chrome extension (Manifest V3). install from source:
        </p>
        <pre className="tutorial-code-block">
          <code>{tutorialInstallCommands.join("\n")}</code>
        </pre>
        <p className="tutorial-p">
          then in Chrome open <code className="inline-code">chrome://extensions</code>, enable
          Developer Mode, choose Load unpacked, and select the{" "}
          <code className="inline-code">wallet-extension/dist/</code> folder.
        </p>
        <p className="tutorial-p">
          the extension adds a <strong>side panel</strong> (primary surface) and a{" "}
          <strong>popup</strong> (quick actions). both share the same React shell.
        </p>
      </section>

      <nav className="tutorial-toc" aria-label="on this page">
        <span className="tutorial-toc-label">jump to</span>
        <ul className="tutorial-toc-list">
          {tutorialSteps.map((s) => (
            <li key={s.id}>
              <a href={`#tutorial-${s.id}`}>{s.short}</a>
            </li>
          ))}
          <li>
            <a href="#tutorial-quickref">quick ref</a>
          </li>
        </ul>
      </nav>

      {tutorialSteps.map((step, idx) => (
        <section
          key={step.id}
          id={`tutorial-${step.id}`}
          className="tutorial-step"
          aria-labelledby={`tutorial-step-${step.id}`}
        >
          <div className="tutorial-step-head">
            <span className="tutorial-step-index">{idx + 2}</span>
            <h2 id={`tutorial-step-${step.id}`} className="tutorial-step-title">
              {step.title}
            </h2>
          </div>
          {step.body.map((p, bi) => (
            <p key={`${step.id}-${bi}`} className="tutorial-p">
              {p}
            </p>
          ))}
          {step.images && step.images.length > 0 ? (
            <div
              className={
                step.images.length > 1 ? "tutorial-shot-row" : "tutorial-shot-row tutorial-shot-row--single"
              }
            >
              {step.images.map((img) => (
                <figure key={img.src} className="tutorial-shot">
                  <img src={img.src} alt={img.alt} loading="lazy" decoding="async" />
                </figure>
              ))}
            </div>
          ) : null}
        </section>
      ))}

      <section id="tutorial-quickref" className="tutorial-quickref" aria-labelledby="qr-heading">
        <h2 id="qr-heading" className="tutorial-section-title">
          quick reference
        </h2>
        <div className="tutorial-table-wrap">
          <table className="tutorial-table">
            <thead>
              <tr>
                <th scope="col">action</th>
                <th scope="col">where</th>
              </tr>
            </thead>
            <tbody>
              {tutorialQuickRef.map((row) => (
                <tr key={row.action}>
                  <td>{row.action}</td>
                  <td>{row.where}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="tutorial-more" aria-labelledby="more-heading">
        <h2 id="more-heading" className="tutorial-section-title">
          read next
        </h2>
        <ul className="tutorial-more-list">
          <li>
            <Link to="/library/user/readme">user guides</Link> - exhaustive per-feature how-tos
          </li>
          <li>
            <Link to="/library/tech/readme">tech guides</Link> - implementation notes
          </li>
          <li>
            <Link to="/roadmap">roadmap</Link> - what we are building next
          </li>
          <li>
            <a
              href="https://github.com/kitty4D/chromatika/blob/main/wallet-extension/docs/architecture-final.html"
              target="_blank"
              rel="noopener noreferrer"
            >
              architecture diagram (repo)
            </a>
          </li>
        </ul>
      </section>
    </div>
  );
}
