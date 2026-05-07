import { useEffect, useRef } from "react";

const CAP_DEG = 4;
const PX_MULT = 5;
const PY_MULT = 4;
const SCROLL_AMP = 1.2;

/**
 * brand mark that subtly tilts toward pointer / touch; scroll adds a tiny wobble.
 * rotation is capped so the SVG never reads edge-on.
 */
export function TiltLogo({ variant = "hero" }: { variant?: "hero" }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({
    targetRx: 0,
    targetRy: 0,
    rx: 0,
    ry: 0,
    scrollBonusRy: 0,
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    if (!stageRef.current) return;

    let raf = 0;

    function applyPointer(clientX: number, clientY: number) {
      const el = stageRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const px = (clientX - r.left) / r.width - 0.5;
      const py = (clientY - r.top) / r.height - 0.5;
      const s = stateRef.current;
      s.targetRy = Math.max(-CAP_DEG, Math.min(CAP_DEG, px * PX_MULT));
      s.targetRx = Math.max(-CAP_DEG, Math.min(CAP_DEG, -py * PY_MULT));
    }

    function onMove(e: MouseEvent) {
      applyPointer(e.clientX, e.clientY);
    }

    function onTouch(e: TouchEvent) {
      const t = e.touches[0];
      if (!t) return;
      applyPointer(t.clientX, t.clientY);
    }

    function onScroll() {
      const s = stateRef.current;
      s.scrollBonusRy = Math.sin(window.scrollY * 0.0028) * SCROLL_AMP;
    }

    function tick() {
      const s = stateRef.current;
      const wantRx = Math.max(-CAP_DEG, Math.min(CAP_DEG, s.targetRx));
      const wantRy = Math.max(-CAP_DEG, Math.min(CAP_DEG, s.targetRy + s.scrollBonusRy));
      s.rx += (wantRx - s.rx) * 0.12;
      s.ry += (wantRy - s.ry) * 0.12;
      s.targetRx *= 0.988;
      s.targetRy *= 0.988;

      if (stageRef.current) {
        stageRef.current.style.transform = `perspective(1400px) rotateX(${s.rx.toFixed(3)}deg) rotateY(${s.ry.toFixed(3)}deg)`;
      }
      raf = requestAnimationFrame(tick);
    }

    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("touchmove", onTouch, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onTouch);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <div
      className={`tilt-logo-stage tilt-logo-stage--${variant}`}
      ref={stageRef}
      aria-label="Chromatika mark"
    >
      <img
        src="/images/chromatika.svg"
        alt=""
        className="tilt-logo-img"
        width={560}
        height={560}
        decoding="async"
      />
    </div>
  );
}
