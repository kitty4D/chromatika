/**
 * Asserts the home-route initial JS payload stays under a budget.
 * Runs after `vite build` (added to the pnpm `build` script).
 *
 * Logic: scan dist/index.html for the entry script, recursively follow modulepreload links,
 * sum the gzipped byte total of those chunks. fail if total > BUDGET_BYTES.
 *
 * Tune via WEBSITE_BUNDLE_BUDGET_KB (env var, gzip kilobytes). default 400 KB gzip.
 */
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "..", "dist");
const BUDGET_KB = Number(process.env.WEBSITE_BUNDLE_BUDGET_KB ?? "400");
const BUDGET = BUDGET_KB * 1024;

if (!fs.existsSync(DIST)) {
  console.warn("check-bundle-size: dist/ missing, skipping");
  process.exit(0);
}

const indexPath = path.join(DIST, "index.html");
const html = fs.readFileSync(indexPath, "utf8");

const scriptHrefs = Array.from(html.matchAll(/<script[^>]*src="([^"]+)"/g), (m) => m[1]);
const preloadHrefs = Array.from(
  html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g),
  (m) => m[1]
);

const homeAssets = Array.from(new Set([...scriptHrefs, ...preloadHrefs]))
  .filter((h) => h.startsWith("/") && h.endsWith(".js"))
  .map((h) => path.join(DIST, h.slice(1)));

let totalGz = 0;
const breakdown = [];
for (const file of homeAssets) {
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file);
  const gz = gzipSync(raw).length;
  totalGz += gz;
  breakdown.push({ file: path.relative(DIST, file), bytes: raw.length, gz });
}

const totalKb = (totalGz / 1024).toFixed(1);
const budgetKb = (BUDGET / 1024).toFixed(0);

console.log(`home-route initial JS (gzipped): ${totalKb} KB / budget ${budgetKb} KB`);
for (const b of breakdown.sort((a, b) => b.gz - a.gz)) {
  const kb = (b.gz / 1024).toFixed(1);
  console.log(`  ${kb.padStart(7)} KB  ${b.file}`);
}

if (totalGz > BUDGET) {
  console.error(
    `\nFAIL: home-route initial JS exceeds the perf budget by ${((totalGz - BUDGET) / 1024).toFixed(1)} KB (gzipped).`
  );
  console.error("  - investigate which chunks grew (compare against the breakdown above)");
  console.error(
    "  - consider lazy-loading new routes, splitting heavy deps, or raising WEBSITE_BUNDLE_BUDGET_KB if the growth is intentional"
  );
  process.exit(1);
}
