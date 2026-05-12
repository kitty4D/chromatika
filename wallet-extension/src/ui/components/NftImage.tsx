/**
 * NftImage — thin wrapper around <img> that routes the source URL through the
 * offscreen media cache. MediaSafetyMode filtering happens upstream (caller
 * passes `null` for filtered URLs), so this component renders a placeholder
 * whenever `src` is null OR the cache returns a failure.
 *
 * Per-instance lifecycle: mount -> request bytes -> mint a blob URL -> render.
 * Unmount or src change -> revoke the previous blob URL to free memory.
 */

import { useEffect, useRef, useState } from 'react';
import { fetchCachedMediaBytes } from '@/lib/media-cache-client';

interface NftImagePlaceholderProps {
  className?: string;
}

function DefaultPlaceholder({ className }: NftImagePlaceholderProps) {
  return <div className={className ?? 'sp-nftImgPlaceholder'}>🖼</div>;
}

export interface NftImageProps {
  src: string | null | undefined;
  alt: string;
  loading?: 'lazy' | 'eager';
  placeholder?: React.ReactNode;
  className?: string;
}

export function NftImage({ src, alt, loading = 'lazy', placeholder, className }: NftImageProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const lastBlobRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    if (!src) {
      if (lastBlobRef.current) {
        URL.revokeObjectURL(lastBlobRef.current);
        lastBlobRef.current = null;
      }
      setBlobUrl(null);
      return;
    }

    void (async () => {
      const result = await fetchCachedMediaBytes(src);
      if (cancelled) return;
      if (!result.ok) {
        setFailed(true);
        return;
      }
      const blob = new Blob([result.bytes], { type: result.contentType });
      const url = URL.createObjectURL(blob);
      if (lastBlobRef.current) URL.revokeObjectURL(lastBlobRef.current);
      lastBlobRef.current = url;
      setBlobUrl(url);
    })();

    return () => {
      cancelled = true;
    };
  }, [src]);

  // revoke on unmount
  useEffect(() => {
    return () => {
      if (lastBlobRef.current) {
        URL.revokeObjectURL(lastBlobRef.current);
        lastBlobRef.current = null;
      }
    };
  }, []);

  if (!src || failed || !blobUrl) {
    return <>{placeholder ?? <DefaultPlaceholder className={className ? `${className} sp-nftImgPlaceholder` : undefined} />}</>;
  }

  return <img src={blobUrl} alt={alt} loading={loading} className={className} onError={() => setFailed(true)} />;
}
