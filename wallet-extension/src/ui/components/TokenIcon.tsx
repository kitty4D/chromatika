import { useState } from 'react';

const GLYPH_COLORS = [
  '#a78bfa', '#60a5fa', '#f472b6', '#34d399',
  '#fbbf24', '#fb923c', '#818cf8', '#2dd4bf',
];

function hashColor(symbol: string): string {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = ((h << 5) - h + symbol.charCodeAt(i)) | 0;
  return GLYPH_COLORS[Math.abs(h) % GLYPH_COLORS.length]!;
}

export function TokenIcon({
  iconUrl,
  symbol,
  chainLogoUrl,
  size = 20,
}: {
  iconUrl?: string | null;
  symbol: string;
  chainLogoUrl?: string | null;
  size?: 20 | 32;
}) {
  const [failed, setFailed] = useState(false);
  const badgeSize = size === 32 ? 14 : 12;

  return (
    <span
      className="cp-tokIcon"
      style={{ width: size, height: size, fontSize: size === 32 ? 14 : 10 }}
    >
      {iconUrl && !failed ? (
        <img
          src={iconUrl}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          style={{ borderRadius: '50%', display: 'block', objectFit: 'cover' }}
        />
      ) : (
        <span
          className="cp-tokIcon__fallback"
          style={{ background: hashColor(symbol) }}
          aria-hidden
        >
          {symbol.charAt(0).toUpperCase()}
        </span>
      )}
      {chainLogoUrl ? (
        <img
          className="cp-tokIcon__badge"
          src={chainLogoUrl}
          alt=""
          width={badgeSize}
          height={badgeSize}
          draggable={false}
        />
      ) : null}
    </span>
  );
}
