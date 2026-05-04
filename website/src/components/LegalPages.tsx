import type { ReactNode } from "react";
import { Link } from "react-router-dom";

function LegalArticle({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <article className="page-legal">
      <header className="page-header">
        <h1>{title}</h1>
      </header>
      <div className="legal-body">{children}</div>
      <footer className="article-footer">
        <Link to="/legal/privacy" className="text-link">
          privacy
        </Link>
        <Link to="/legal/terms" className="text-link">
          terms
        </Link>
        <Link to="/" className="text-link">
          home
        </Link>
      </footer>
    </article>
  );
}

export function PrivacyPolicy() {
  return (
    <div className="page-legal-wrap">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">privacy</span>
      </nav>
      <LegalArticle title="privacy policy">
        <p className="legal-updated">last updated: 2026-04-30</p>
        <p>
          this policy covers the chromatika marketing and documentation site (the "site") and
          describes our current pre-release posture. the chromatika browser extension handles
          sensitive key material locally; this page is not a substitute for reading{" "}
          <code className="inline-code">wallet-extension/docs/WALLET_SECURITY.md</code> in the
          repository.
        </p>
        <h2>what we collect on this site</h2>
        <p>
          the static site as built in <code className="inline-code">website/</code> does not embed
          third-party analytics in tree. if a future deploy adds analytics or hosted forms, this
          section will name the vendor, purpose, and retention.
        </p>
        <h2>extension data</h2>
        <p>
          wallet secrets stay on your device inside the extension sandbox. we do not operate a
          hosted backend that stores your seed phrase or app password for the pre-release builds
          described in the open source repo.
        </p>
        <h2>contact</h2>
        <p>
          questions: reach the maintainer on{" "}
          <a href="https://x.com/kitty4dhd" target="_blank" rel="noopener noreferrer">
            @kitty4dhd
          </a>{" "}
          or via the{" "}
          <a href="https://github.com/kitty4D/chromatika" target="_blank" rel="noopener noreferrer">
            github repository
          </a>
          .
        </p>
      </LegalArticle>
    </div>
  );
}

export function TermsOfService() {
  return (
    <div className="page-legal-wrap">
      <nav className="crumbs" aria-label="breadcrumb">
        <Link to="/">home</Link>
        <span aria-hidden="true">/</span>
        <span className="crumbs-current">terms</span>
      </nav>
      <LegalArticle title="terms of service">
        <p className="legal-updated">last updated: 2026-04-30</p>
        <p>
          by using the chromatika site, extension builds from the open repository, or any linked
          pre-release artifacts, you agree you are doing so at your own risk. chromatika is{" "}
          <strong>pre-release</strong> software: features, cryptography, and storage formats may
          change without migration paths for older developer installs.
        </p>
        <h2>no warranty</h2>
        <p>
          the software and documentation are provided "as is" without warranty of any kind. we
          disclaim liability for lost funds, failed transactions, phishing, or incorrect
          documentation.
        </p>
        <h2>not financial or legal advice</h2>
        <p>
          nothing on the site or in the repo is investment, tax, or legal advice. you are
          responsible for compliance in your jurisdiction and for verifying every transaction you
          sign.
        </p>
        <h2>third parties</h2>
        <p>
          dapps, RPC endpoints, indexers, and chain protocols are third parties. your use of them is
          between you and those services.
        </p>
        <h2>changes</h2>
        <p>
          we may update these terms as the project matures. continued use after changes means you
          accept the revised terms.
        </p>
      </LegalArticle>
    </div>
  );
}
