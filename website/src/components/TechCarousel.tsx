import { useCallback, useEffect, useState } from "react";
import { homeTechCarouselSlides } from "../data/home-tech";

const AUTO_ADVANCE_MS = 7000;

function ChevronLeftIcon() {
  return (
    <svg
      className="tech-carousel-chevron"
      viewBox="0 0 24 24"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <path
        d="M14 7l-5 5 5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      className="tech-carousel-chevron"
      viewBox="0 0 24 24"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <path
        d="M10 7l5 5-5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** inline so the mark always paints (external SVG in `<img>` was flaky for some users). */
function LazorkitCarouselMark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect width="100" height="100" rx="22" fill="#7c3aed" />
      <path d="M28 30 Q24 30 24.5 32.5 L44 48 Q50 52 56 48 L72 32 Q74 30 70 30 Z" fill="#fff" />
      <path d="M28 70 Q24 70 24.5 67.5 L44 52 Q50 48 56 52 L72 68 Q74 70 70 70 Z" fill="#fff" />
    </svg>
  );
}

export function TechCarousel() {
  const [i, setI] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focusedWithin, setFocusedWithin] = useState(false);

  const n = homeTechCarouselSlides.length;
  const slide = homeTechCarouselSlides[i]!;

  const pauseAuto = hovered || focusedWithin;

  const go = useCallback(
    (dir: -1 | 1) => {
      setI((x) => (x + dir + n) % n);
    },
    [n]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (pauseAuto) return;
    const t = window.setInterval(() => {
      setI((x) => (x + 1) % n);
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(t);
  }, [pauseAuto, n]);

  return (
    <div
      className="tech-carousel"
      aria-roledescription="carousel"
      aria-label="technologies used in chromatika"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocusedWithin(true)}
      onBlurCapture={(e) => {
        const root = e.currentTarget;
        window.requestAnimationFrame(() => {
          if (!root.contains(document.activeElement)) setFocusedWithin(false);
        });
      }}
    >
      <div className="tech-carousel-header">
        <p className="tech-carousel-kicker">technology used</p>
        <div className="tech-carousel-controls">
          <button
            type="button"
            className="tech-carousel-btn tech-carousel-btn--nav"
            aria-label="Previous panel"
            onClick={() => go(-1)}
          >
            <ChevronLeftIcon />
          </button>
          <span className="tech-carousel-dots" aria-hidden="true">
            {homeTechCarouselSlides.map((s, j) => (
              <button
                key={s.id}
                type="button"
                className={`tech-carousel-dot ${j === i ? "tech-carousel-dot--active" : ""}`}
                aria-label={`Show ${s.title}`}
                aria-current={j === i ? "true" : undefined}
                onClick={() => setI(j)}
              />
            ))}
          </span>
          <button
            type="button"
            className="tech-carousel-btn tech-carousel-btn--nav"
            aria-label="Next panel"
            onClick={() => go(1)}
          >
            <ChevronRightIcon />
          </button>
        </div>
      </div>

      <article key={slide.id} className="tech-carousel-panel" aria-live="polite">
        <div className="tech-carousel-panel-head">
          <h2 className="tech-carousel-title">{slide.title}</h2>
          <div className="tech-carousel-logo-corner">
            {slide.id === "lazorkit" ? (
              <LazorkitCarouselMark className="tech-carousel-logo tech-carousel-logo--inline" />
            ) : slide.logoSrc ? (
              <img
                src={slide.logoSrc}
                alt=""
                className={
                  slide.id === "encrypt"
                    ? "tech-carousel-logo tech-carousel-logo--encrypt"
                    : "tech-carousel-logo"
                }
                decoding="async"
              />
            ) : null}
          </div>
        </div>
        <p className="tech-carousel-intro">{slide.intro}</p>
        <hr className="tech-carousel-split" aria-hidden="true" />
        <h3 className="tech-carousel-how-title">how we use it</h3>
        <p className="tech-carousel-body">{slide.howWeUse}</p>
        {slide.howWeUseBullets && slide.howWeUseBullets.length > 0 ? (
          <ul className="tech-carousel-bullets">
            {slide.howWeUseBullets.map((item, bi) => (
              <li key={`${slide.id}-b-${bi}`}>{item}</li>
            ))}
          </ul>
        ) : null}
        <nav className="tech-carousel-links" aria-label={`${slide.title} external links`}>
          {slide.links.map((link) => (
            <a
              key={link.href}
              className="tech-carousel-link"
              href={link.href}
              target="_blank"
              rel="noreferrer"
            >
              {link.label} ↗
            </a>
          ))}
        </nav>
      </article>
    </div>
  );
}
