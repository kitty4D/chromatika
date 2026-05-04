import { TechCarousel } from "./TechCarousel";

/** static mock of the wallet vault tab: popup-shaped frame plus tech carousel aside. */
export function WalletVaultPreview() {
  return (
    <section className="wallet-preview" aria-label="wallet preview and tech highlights">
      <div className="wallet-preview-split">
        <div className="wallet-preview-aside">
          <TechCarousel />
        </div>

        <div className="wallet-preview-frame-outer">
          <div className="wallet-preview-frame" role="img" aria-label="mock Chromatika vault tab">
            <div className="wallet-preview-chrome">
              <p className="wallet-preview-kicker">fixture · vault tab</p>

              <div className="wallet-preview-body">
                <div className="wallet-preview-cockpit">
                  <div className="wp-rocket">
                    <div className="wp-pilots" aria-label="cockpit pilots">
                      <span className="wp-pilot">
                        <span className="wp-pilot-dot" />
                        David
                      </span>
                      <span className="wp-pilot wp-pilot--co">
                        <span className="wp-pilot-dot wp-pilot-dot--co" />
                        Toly
                      </span>
                    </div>
                    <div className="wp-gauge-row">
                      <div className="wp-gauge wp-gauge--sui" data-health="green">
                        <div className="wp-gauge-track">
                          <div className="wp-gauge-fill" style={{ transform: "scaleX(0.82)" }} />
                        </div>
                        <span className="wp-gauge-cap">SUI 12.40</span>
                      </div>
                      <div className="wp-gauge wp-gauge--ika" data-health="green">
                        <div className="wp-gauge-track">
                          <div className="wp-gauge-fill" style={{ transform: "scaleX(0.71)" }} />
                        </div>
                        <span className="wp-gauge-cap">IKA 8.2</span>
                      </div>
                    </div>
                    <div className="wp-rocket-illus" aria-hidden="true">
                      <svg className="wp-rocket-svg" viewBox="0 0 200 48" fill="none">
                        <path
                          d="M20 38L100 8l80 30-80 6L20 38z"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          opacity="0.35"
                        />
                        <path
                          d="M96 12l8 26M72 22l56 8"
                          stroke="currentColor"
                          strokeWidth="0.8"
                          opacity="0.25"
                        />
                      </svg>
                    </div>
                  </div>

                  <div className="wp-base-card" data-vault-health="green">
                    <div className="wp-base-inner">
                      <div className="wp-base-copy">
                        <div className="wp-vault-name">main vault</div>
                        <div className="wp-vault-kicker">dWallet Vault Account</div>
                        <div className="wp-addr">0x7a3f…c21e</div>
                      </div>
                      <div className="wp-base-rail" aria-hidden="true">
                        <span className="wp-icon-faux" />
                        <span className="wp-icon-faux" />
                        <span className="wp-icon-faux" />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="wallet-preview-dwallets">
                  <div className="wp-section-head">
                    <span className="wp-section-title">your dWallets</span>
                    <span className="wp-manage-faux" aria-hidden="true" />
                  </div>
                  <ul className="wp-dw-list">
                    <li className="wp-dw-card">
                      <div className="wp-dw-top">
                        <span className="wp-dw-name">David · secp</span>
                        <span className="wp-dw-pill">main</span>
                      </div>
                      <div className="wp-dw-addr">0x4b8e…91aa</div>
                      <div className="wp-dw-chips">
                        <span>evm</span>
                        <span>btc</span>
                      </div>
                    </li>
                    <li className="wp-dw-card">
                      <div className="wp-dw-top">
                        <span className="wp-dw-name">Toly · ed25519</span>
                        <span className="wp-dw-pill wp-dw-pill--alt">sol · sui · apt</span>
                      </div>
                      <div className="wp-dw-addr">6Fh9…qR2m</div>
                      <div className="wp-dw-chips">
                        <span>solana</span>
                        <span>sui</span>
                      </div>
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
