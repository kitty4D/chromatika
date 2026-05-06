import { Link } from "react-router-dom";

const GITHUB_REPO_HREF = "https://github.com/kitty4D/chromatika";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-top">
          <div className="site-footer-brand">
            <span className="site-footer-mark">chromatika</span>
            <span className="site-footer-tagline">pre-release browser wallet</span>
          </div>
          <div className="site-footer-cols" role="navigation" aria-label="footer">
            <div className="site-footer-col">
              <h2 className="site-footer-heading">guides</h2>
              <ul className="site-footer-links">
                <li>
                  <Link to="/library/user/readme">user guides</Link>
                </li>
                <li>
                  <Link to="/library/tech/readme">tech guides</Link>
                </li>
              </ul>
            </div>
            <div className="site-footer-col">
              <h2 className="site-footer-heading">knowledge base</h2>
              <ul className="site-footer-links">
                <li>
                  <Link to="/knowledge-base">browse topics</Link>
                </li>
              </ul>
            </div>
            <div className="site-footer-col">
              <h2 className="site-footer-heading">legal</h2>
              <ul className="site-footer-links">
                <li>
                  <Link to="/legal/privacy">privacy policy</Link>
                </li>
                <li>
                  <Link to="/legal/terms">terms of service</Link>
                </li>
              </ul>
            </div>
            <div className="site-footer-col">
              <h2 className="site-footer-heading">code &amp; social</h2>
              <ul className="site-footer-links">
                <li>
                  <a href={GITHUB_REPO_HREF} target="_blank" rel="noopener noreferrer">
                    github / kitty4D/chromatika
                  </a>
                </li>
                <li>
                  <a href="https://x.com/kitty4dhd" target="_blank" rel="noopener noreferrer">
                    @kitty4dhd
                  </a>
                </li>
                <li>
                  <a href="https://x.com/chromat_ika" target="_blank" rel="noopener noreferrer">
                    @chromat_ika
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </div>
        <p className="site-footer-bottom">
          © {new Date().getFullYear()} chromatika. pre-release software and site copy; when anything
          disagrees with <code className="inline-code">wallet-extension/docs/</code> in the repo,
          trust the repo.
        </p>
      </div>
    </footer>
  );
}
