import { test, expect } from './fixtures';

/**
 * F1 verification: token logos load through the offscreen media cache - the same
 * privacy-preserving path `NftImage` uses (fetch with `credentials: 'omit'` +
 * `referrerPolicy: 'no-referrer'` in the offscreen doc, bytes handed back to the UI
 * and rendered as a blob) - NOT via a direct `<img src>` to a third-party logo host.
 *
 * This drives the exact runtime path `TokenIcon` now uses:
 *   fetchCachedMediaBytes(url)
 *     -> chrome.runtime 'media-cache:ensure-ready' (SW lazy-creates the offscreen doc)
 *     -> chrome.runtime 'media-cache:get'          (offscreen fetches + caches; returns base64)
 * then decodes the base64 wire payload (chrome.runtime messaging is JSON, so bytes ride
 * as base64) and confirms the bytes form a real, decodable image.
 *
 * The URLs below are exactly what `src/background/services/token-metadata.ts` produces
 * (Trust Wallet assets, by chain folder + checksummed contract / mint, or `info/logo.png`
 * for native coins). A green run proves: the resolver's URLs are real images, reachable
 * through the offscreen cache, delivered to the UI, and renderable.
 *
 * NOTE: this test makes real network requests to raw.githubusercontent.com.
 */

const TW = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains';

const LOGOS: Array<{ label: string; url: string }> = [
  { label: 'USDC (ethereum)', url: `${TW}/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png` },
  { label: 'WETH (arbitrum)', url: `${TW}/arbitrum/assets/0x82aF49447D8a07e3bd95BD0d56f35241523fBab1/logo.png` },
  { label: 'native SOL', url: `${TW}/solana/info/logo.png` },
  { label: 'native SUI', url: `${TW}/sui/info/logo.png` },
];

test('token logos resolve + render through the offscreen media cache', async ({ context, extensionId }) => {
  const page = await context.newPage();
  // any extension-origin page gives us chrome.runtime + reaches the media-cache bridge.
  await page.goto(`chrome-extension://${extensionId}/side_panel.html`);
  await page.waitForFunction(() => Boolean(chrome?.runtime?.id), undefined, { timeout: 30_000 });

  for (const { label, url } of LOGOS) {
    const res = await page.evaluate(async (sourceUrl) => {
      await chrome.runtime.sendMessage({ type: 'media-cache:ensure-ready' });
      const r = (await chrome.runtime.sendMessage({ type: 'media-cache:get', sourceUrl })) as
        | { ok: true; contentType: string; bytesB64: string }
        | { ok: false; reason: string };
      if (!r?.ok) return { ok: false as const, reason: r?.reason ?? 'no-response' };

      // decode the base64 wire payload exactly like media-cache-client does
      const binary = atob(r.bytesB64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      // prove the delivered bytes form a real, decodable image (what TokenIcon would render)
      const objUrl = URL.createObjectURL(new Blob([bytes], { type: r.contentType }));
      const decodesToImage = await new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0);
        img.onerror = () => resolve(false);
        img.src = objUrl;
      });
      URL.revokeObjectURL(objUrl);

      return { ok: true as const, contentType: r.contentType, byteLength: bytes.byteLength, decodesToImage };
    }, url);

    expect(res.ok, `${label}: offscreen cache returned ${res.ok ? 'ok' : res.reason}`).toBe(true);
    if (res.ok) {
      expect(res.contentType, `${label}: content-type`).toMatch(/^image\//);
      expect(res.byteLength, `${label}: byte length`).toBeGreaterThan(0);
      expect(res.decodesToImage, `${label}: delivered bytes decode to a valid image`).toBe(true);
    }
  }
});
