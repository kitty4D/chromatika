import { CodeCurrent } from "./CodeCurrent";
import { TiltLogo } from "./TiltLogo";
import { homeIntroFirstSentence } from "../data/home-intro";
import { homeChains, homeFoundationTech } from "../data/home-tech";

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
          targetSelectors: [".home-hero-copy", ".home-hero-logo", ".home-hero-code-bridge"],
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
            <nav className="home-hero-tech" aria-label="core tech links">
              <ul className="home-hero-tech-list">
                {homeFoundationTech.map((t) => (
                  <li key={t.id}>
                    <a
                      className="home-hero-tech-link"
                      href={t.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img
                        src={t.iconSrc}
                        alt=""
                        width={28}
                        height={28}
                        className={
                          t.id === "encrypt"
                            ? "home-hero-tech-icon home-hero-tech-icon--encrypt"
                            : "home-hero-tech-icon"
                        }
                        decoding="async"
                      />
                      <span>{t.label}</span>
                    </a>
                  </li>
                ))}
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
