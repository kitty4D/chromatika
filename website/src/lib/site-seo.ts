/** Canonical site origin for OG URLs, canonical links, and sitemap (no trailing slash). */
export const SITE_ORIGIN = "https://www.chromatika.xyz";

/** Browser tab + root OG/twitter:title (`/` route fallback via useDocHead). Keep website/index.html in sync (SPA-less crawl sees shell HTML first). */
export const HOME_DOCUMENT_TITLE = "Chromatika Wallet: User Guides and Tech Docs";

/** Default meta description (~155 chars) for index and useDocHead fallback. */
export const DEFAULT_SITE_DESCRIPTION =
  "Chromatika Wallet: user guides, tech guides, and a knowledge base for this dWallet-first multi-chain browser wallet.";

/**
 * Path under `public/` for the default social preview image (1200x630 PNG).
 * Generated from `public/images/og-chromatika.png` via `pnpm run generate:og`.
 */
export const DEFAULT_OG_IMAGE_PATH = "/images/og-chromatika-1200x630.png";

export const DEFAULT_OG_IMAGE_ALT =
  "Chromatika wordmark and multi-chain visuals for the browser wallet companion site.";

export function absoluteSiteUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${SITE_ORIGIN}${path}`;
}
