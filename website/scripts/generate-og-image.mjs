/**
 * Produce a 1200x630 OG/Twitter thumbnail from `public/images/og-chromatika.png`.
 * Run: node scripts/generate-og-image.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "public", "images", "og-chromatika.png");
const DST = path.join(ROOT, "public", "images", "og-chromatika-1200x630.png");

async function main() {
  const buf = await sharp(SRC)
    .resize(1200, 630, { fit: "cover", position: "center" })
    .png({
      compressionLevel: 9,
    })
    .toBuffer();
  fs.writeFileSync(DST, buf);
  const meta = await sharp(DST).metadata();
  console.log(`wrote ${path.relative(ROOT, DST)} (${meta.width}x${meta.height})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
