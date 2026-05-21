import { useMemo } from 'react';

export type ChartPoint = { timestamp: number; price: number };

const CHART_W = 320;
const CHART_H = 140;
const PAD_TOP = 8;
const PAD_BOT = 4;

export function PriceChart({ points, up }: { points: ChartPoint[]; up: boolean }) {
  const path = useMemo(() => {
    if (points.length < 2) return null;
    const minP = Math.min(...points.map((p) => p.price));
    const maxP = Math.max(...points.map((p) => p.price));
    const range = maxP - minP || 1;
    const usableH = CHART_H - PAD_TOP - PAD_BOT;

    const coords = points.map((p, i) => {
      const x = (i / (points.length - 1)) * CHART_W;
      const y = PAD_TOP + usableH - ((p.price - minP) / range) * usableH;
      return { x, y };
    });

    const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
    const last = coords[coords.length - 1]!;
    const first = coords[0]!;
    const area = `${line} L${last.x.toFixed(1)},${CHART_H} L${first.x.toFixed(1)},${CHART_H} Z`;
    return { line, area };
  }, [points]);

  if (!path) {
    return (
      <div className="cp-chartEmpty" style={{ height: CHART_H, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span className="sp-muted" style={{ fontSize: 11 }}>no chart data</span>
      </div>
    );
  }

  const strokeColor = up ? '#22c55e' : '#ef4444';
  const fillColor = up ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.10)';

  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} width="100%" height={CHART_H} preserveAspectRatio="none" style={{ display: 'block' }}>
      <path d={path.area} fill={fillColor} />
      <path d={path.line} fill="none" stroke={strokeColor} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
