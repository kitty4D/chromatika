import { CodeCurrent } from "./CodeCurrent";
import { TiltLogo } from "./TiltLogo";
import { SITE_CHROMATIKA_X_HREF, SITE_GITHUB_REPO_HREF } from "../constants/site-social";
import { homeIntroFirstSentence } from "../data/home-intro";
import { homeChains } from "../data/home-tech";

/** scrollable home masthead: blurb + logo, with light drift around both columns. */
export function HomeHero() {
  return (
    <section className="home-hero" aria-labelledby="home-hero-title">
      <CodeCurrent
        options={{
          count: 9,
          minLifespanSec: 11,
          maxLifespanSec: 20,
          peakOpacity: 0.3,
          maxBlurPx: 1.1,
          maxYawDeg: 6,
          maxZPx: 26,
          peakWidth: 0.07,
          bendWindow: 0.22,
          bandPaddingPx: 6,
          bandHeightPx: 10,
          colorCycleSec: 9,
          targetSelectors: [
            ".home-hero-copy",
            ".home-hero-logo",
            ".home-hero-social",
            ".home-hero-code-bridge",
          ],
        }}
      >
        <div className="home-hero-grid">
          <div className="home-hero-copy">
            <h1 id="home-hero-title" className="home-hero-title">
              <span className="home-hero-title-pre">one vault,</span>{" "}
              <span className="home-hero-title-hit">many chains</span>
            </h1>
            <div className="home-hero-chains-shell">
              <ul className="home-hero-chains" aria-label="supported chains">
                {homeChains.map((c) => (
                  <li key={c.id} className="home-hero-chain-item" title={c.name}>
                    <img
                      src={c.iconSrc}
                      alt=""
                      width={36}
                      height={36}
                      className="home-hero-chain-icon"
                      decoding="async"
                    />
                    <span className="visually-hidden">{c.name}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="home-hero-lead">
              {homeIntroFirstSentence}{" "}
              <a href="#home-learn-more" className="home-hero-lead-more">
                ... learn more
              </a>
            </p>
            <div className="home-hero-code-bridge" aria-hidden="true" />
            <nav className="home-hero-social" aria-label="chromatika on github and x">
              <ul className="home-hero-social-list">
                <li>
                  <a
                    href={SITE_GITHUB_REPO_HREF}
                    className="home-hero-social-link home-hero-social-link--github"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <svg
                      className="home-hero-social-icon"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                    </svg>
                    <span className="home-hero-social-label">View the Source</span>
                  </a>
                </li>
                <li>
                  <a
                    href={SITE_CHROMATIKA_X_HREF}
                    className="home-hero-social-link home-hero-social-link--x"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <svg
                      className="home-hero-social-icon"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                    </svg>
                    <span className="home-hero-social-label">Stay Updated</span>
                  </a>
                </li>
              </ul>
            </nav>
          </div>
          <div className="home-hero-logo">
            <TiltLogo variant="hero" />
          </div>
        </div>
      </CodeCurrent>
    </section>
  );
}
