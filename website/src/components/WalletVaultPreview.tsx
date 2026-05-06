import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useRef, useState } from "react";
import { TechCarousel } from "./TechCarousel";

const PREVIEW_ACK_KEY = "chromatika_site_wallet_preview_ack";

/** Resting opacity for `wallet-preview-intro-panel` (framer sets inline; must match intent). */
const PANEL_REST_OPACITY = 0.85;

/** True when this page load is a full reload (normal F5, hard reload). Not back-forward cache. */
function isPageReload(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const entries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    if (entries.length > 0) {
      return entries[0].type === "reload";
    }
    const legacy = (performance as unknown as { navigation?: { type: number } }).navigation;
    return legacy?.type === 1; // legacy TYPE_RELOAD
  } catch {
    return false;
  }
}

/**
 * sessionStorage is not cleared by "empty cache and hard reload" (only the HTTP cache). Clearing
 * our ack on real reload matches the expectation that a refresh shows the intro again.
 */
function readAcked(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (isPageReload()) {
      sessionStorage.removeItem(PREVIEW_ACK_KEY);
      return false;
    }
    return sessionStorage.getItem(PREVIEW_ACK_KEY) === "1";
  } catch {
    return false;
  }
}

/** Live preview: real `wallet-extension` preview build in `public/wallet-live/`. */
export function WalletVaultPreview() {
  const prefersReduced = useReducedMotion();
  /** Strict Mode dev remount runs exit on AnimatePresence; only persist after a real user dismiss. */
  const userDismissedRef = useRef(false);
  const [overlayOpen, setOverlayOpen] = useState(() => !readAcked());

  const commitAck = useCallback(() => {
    try {
      sessionStorage.setItem(PREVIEW_ACK_KEY, "1");
    } catch {
      /* private mode or quota */
    }
  }, []);

  const handleExitComplete = useCallback(() => {
    if (!userDismissedRef.current) return;
    userDismissedRef.current = false;
    commitAck();
  }, [commitAck]);

  const requestDismiss = useCallback(() => {
    if (userDismissedRef.current) return;
    userDismissedRef.current = true;
    setOverlayOpen(false);
  }, []);

  const scrimEnter = prefersReduced
    ? { duration: 0.08 }
    : { duration: 0.42, ease: [0.22, 1, 0.36, 1] as const };

  const panelEnter = prefersReduced
    ? { duration: 0.08 }
    : { duration: 0.5, delay: 0.05, ease: [0.22, 1, 0.36, 1] as const };

  const exitTx = prefersReduced
    ? { duration: 0.09 }
    : { duration: 0.34, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <section className="wallet-preview" aria-label="wallet preview and tech highlights">
      <div className="wallet-preview-split">
        <div className="wallet-preview-aside">
          <TechCarousel />
        </div>

        <div className="wallet-preview-frame-outer">
          <div className="wallet-preview-frame">
            <div className="wallet-preview-iframe-wrap">
              <iframe
                src="/wallet-live/vault-home.html"
                title="Chromatika vault home (live preview)"
                className="wallet-preview-iframe"
                width="400"
                height="720"
                loading="lazy"
                sandbox="allow-scripts allow-same-origin"
              />
              <AnimatePresence onExitComplete={handleExitComplete}>
                {overlayOpen ? (
                  <motion.div
                    key="wallet-preview-intro"
                    className="wallet-preview-intro"
                    role="button"
                    tabIndex={0}
                    aria-label="Start interacting with the wallet preview"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: exitTx }}
                    transition={scrimEnter}
                    onClick={requestDismiss}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        requestDismiss();
                      }
                    }}
                  >
                    <div className="wallet-preview-intro-scrim" aria-hidden="true" />
                    <motion.div
                      className="wallet-preview-intro-panel"
                      initial={{ opacity: 0, y: 12, scale: 0.97 }}
                      animate={{ opacity: PANEL_REST_OPACITY, y: 0, scale: 1 }}
                      exit={
                        prefersReduced
                          ? { opacity: 0, transition: exitTx }
                          : {
                              opacity: 0,
                              y: -12,
                              scale: 0.98,
                              transition: exitTx,
                            }
                      }
                      transition={panelEnter}
                      whileHover={
                        prefersReduced
                          ? undefined
                          : {
                              y: -3,
                              transition: {
                                duration: 0.28,
                                ease: [0.22, 1, 0.36, 1],
                              },
                            }
                      }
                    >
                      <span className="wallet-preview-intro-badge">browser embed</span>
                      <h2 className="wallet-preview-intro-title">interactive preview</h2>
                      <p className="wallet-preview-intro-body">
                        this is the real chromatika wallet shell with demo data. some actions stay
                        off in the browser embed on purpose (sends, settings writes, chain calls).
                      </p>
                      <p className="wallet-preview-intro-cta">
                        <motion.span
                          className="wallet-preview-intro-cta-inner"
                          animate={prefersReduced ? undefined : { scale: [1, 1.045, 1] }}
                          transition={
                            prefersReduced
                              ? undefined
                              : {
                                  duration: 2.75,
                                  repeat: Infinity,
                                  ease: "easeInOut",
                                }
                          }
                        >
                          try the demo
                        </motion.span>
                      </p>
                    </motion.div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
