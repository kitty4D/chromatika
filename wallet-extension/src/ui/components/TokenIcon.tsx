import { useEffect, useRef, useState } from 'react';
import { fetchCachedMediaBytes } from '@/lib/media-cache-client';

const GLYPH_COLORS = [
  '#a78bfa', '#60a5fa', '#f472b6', '#34d399',
  '#fbbf24', '#fb923c', '#818cf8', '#2dd4bf',
];

function hashColor(symbol: string): string {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = ((h << 5) - h + symbol.charCodeAt(i)) | 0;
  return GLYPH_COLORS[Math.abs(h) % GLYPH_COLORS.length]!;
}

function isRemoteUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/**
 * Resolve an icon URL to something we can hand to <img src>.
 *
 * Remote (http/https) logo hosts NEVER get a direct <img src> - that would leak
 * the user's IP + referer to whatever third party serves the logo. Instead we
 * pull the bytes through the offscreen media cache (credentials omit, no
 * referrer, 7-day byte cache, graceful failure) and mint a per-instance blob
 * URL, exactly like NftImage does. Extension-local + data: URLs have no privacy
 * concern, so they render directly with no blob round-trip.
 *
 * Returns null while a remote logo is loading or after it fails; callers render
 * their fallback (the letter glyph) in that case.
 */
function useCachedImageSrc(url: string | null | undefined): string | null {
  const [src, setSrc] = useState<string | null>(() =>
    url && !isRemoteUrl(url) ? url : null,
  );
  const lastBlobRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const revoke = () => {
      if (lastBlobRef.current) {
        URL.revokeObjectURL(lastBlobRef.current);
        lastBlobRef.current = null;
      }
    };

    if (!url) {
      revoke();
      setSrc(null);
      return;
    }
    if (!isRemoteUrl(url)) {
      revoke();
      setSrc(url);
      return;
    }

    setSrc(null);
    void (async () => {
      const result = await fetchCachedMediaBytes(url);
      if (cancelled) return;
      if (!result.ok) {
        setSrc(null);
        return;
      }
      const blobUrl = URL.createObjectURL(new Blob([result.bytes], { type: result.contentType }));
      revoke();
      lastBlobRef.current = blobUrl;
      setSrc(blobUrl);
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    return () => {
      if (lastBlobRef.current) {
        URL.revokeObjectURL(lastBlobRef.current);
        lastBlobRef.current = null;
      }
    };
  }, []);

  return src;
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
  const badgeSize = size === 32 ? 14 : 12;
  const iconSrc = useCachedImageSrc(iconUrl);
  const badgeSrc = useCachedImageSrc(chainLogoUrl);

  return (
    <span
      className="cp-tokIcon"
      style={{ width: size, height: size, fontSize: size === 32 ? 14 : 10 }}
    >
      {iconSrc ? (
        <img
          src={iconSrc}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          draggable={false}
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
      {badgeSrc ? (
        <img
          className="cp-tokIcon__badge"
          src={badgeSrc}
          alt=""
          width={badgeSize}
          height={badgeSize}
          draggable={false}
        />
      ) : null}
    </span>
  );
}
