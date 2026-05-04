/**
 * rasterizes the cat logo (cat face + 3D glasses) into MV3 manifest sizes (toolbar,
 * chrome://extensions, etc.).
 * source: public/chromatika-cat-logo.png
 * outputs: public/chromatika-logo-{16,32,48,128}.png
 *
 * the full mark (public/chromatika.svg, with the key) is the source for the EIP-6963
 * dapp icon where 96px gives the key detail enough room to read. toolbar uses the
 * cat mark so the silhouette stays recognizable at 16/32.
 *
 * same PNG is trimmed, scaled up slightly (CONTENT_SCALE) so the cat fills the pixel box like
 * other extensions, then exported at each size.
 *
 * run: pnpm run gen:extension-icons
 */
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const srcPng = join(root, 'public/chromatika-cat-logo.png');

// per-size tuning (same source for every output: trim, pad, then resize).
const sizes = [
  { size: 16, sharpen: { sigma: 0.6 }, saturation: 1.35 },
  { size: 32, sharpen: { sigma: 0.5 }, saturation: 1.25 },
  { size: 48, sharpen: { sigma: 0.4 }, saturation: 1.15 },
  { size: 128, sharpen: null, saturation: 1.0 },
];

// trim transparent padding, scale up so the cat matches other extensions' visual weight in the
// toolbar (Chrome uses the full 16/32px box; too much safe-zone reads "tiny").
// tiny outer margin so ears / glasses survive toolbar rounding.
const CONTENT_SCALE = 1.14;
const MARGIN_PCT = 0.02;
const trimmed = sharp(srcPng).trim({
  background: { r: 0, g: 0, b: 0, alpha: 0 },
  threshold: 1,
});
const trimmedMeta = await trimmed.clone().metadata();
const tw = trimmedMeta.width ?? 1;
const th = trimmedMeta.height ?? 1;
const scaledW = Math.max(1, Math.round(tw * CONTENT_SCALE));
const scaledH = Math.max(1, Math.round(th * CONTENT_SCALE));
const scaledBuf = await trimmed.resize(scaledW, scaledH, { kernel: 'lanczos3' }).png().toBuffer();
const side = Math.max(scaledW, scaledH);
const canvas = Math.round(side * (1 + MARGIN_PCT * 2));
const dx = Math.round((canvas - scaledW) / 2);
const dy = Math.round((canvas - scaledH) / 2);
const master = await sharp({
  create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: scaledBuf, top: dy, left: dx }])
  .png()
  .toBuffer();

for (const { size, sharpen, saturation } of sizes) {
  let pipe = sharp(master).resize(size, size, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
    kernel: 'lanczos3',
  });
  if (saturation !== 1.0) pipe = pipe.modulate({ saturation });
  if (sharpen) pipe = pipe.sharpen(sharpen);
  const buf = await pipe.png({ compressionLevel: 9 }).toBuffer();
  const out = join(root, `public/chromatika-logo-${size}.png`);
  writeFileSync(out, buf);
  console.log('wrote', out, `(${buf.length} bytes)`);
}
