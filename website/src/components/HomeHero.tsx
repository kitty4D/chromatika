import { CodeCurrent } from "./CodeCurrent";
import { TiltLogo } from "./TiltLogo";
import { homeChains, homeFoundationTech } from "../data/home-tech";

/** scrollable home masthead: blurb + logo, with light drift around both columns. */
export function HomeHero() {
  return (
    <section className="home-hero" aria-labelledby="home-hero-title">
      <CodeCurrent
        options={{
          count: 5,
          minLifespanSec: 22,
          maxLifespanSec: 38,
          peakOpacity: 0.3,
          maxBlurPx: 1.1,
          maxYawDeg: 6,
          maxZPx: 26,
          peakWidth: 0.07,
          bendWindow: 0.22,
          bandPaddingPx: 6,
          bandHeightPx: 10,
          targetSelectors: [".home-hero-copy", ".home-hero-logo"],
        }}
      >
        <div className="home-hero-grid">
          <div className="home-hero-copy">
            <h1 id="home-hero-title" className="home-hero-title">
              one vault, many chains
            </h1>
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
            <p className="home-hero-lead">
              Chromatika is a Chromium extension wallet: one Argon2id-encrypted vault, ika dWallet
              identity, and the usual chains (Bitcoin, EVM, Solana, Sui, Aptos) from a side panel
              and popup. this site is the companion hub: user guides, tech guides, a searchable
              knowledge base, and honest pre-release notes while you try the build or read how the
              pieces fit together.
            </p>
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
