/**
 * builds dist/sitemap.xml from the shared route enumerator in route-meta.mjs.
 * runs as a vite plugin closeBundle hook (see vite.config.ts).
 *
 * route list is the single source of truth from scripts/route-meta.mjs (enumerateRoutes).
 * site URL can be overridden via SITE_URL env var; otherwise syncs from src/lib/site-seo.ts (SITE_ORIGIN).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enumerateRoutes, SITE_ORIGIN } from "./route-meta.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SITE_URL = (process.env.SITE_URL || SITE_ORIGIN).replace(/\/+$/, "");

export function buildSitemapXml() {
  const today = new Date().toISOString().slice(0, 10);
  const urls = enumerateRoutes();

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  for (const u of urls) {
    lines.push("  <url>");
    lines.push(`    <loc>${SITE_URL}${u}</loc>`);
    lines.push(`    <lastmod>${today}</lastmod>`);
    lines.push(`    <changefreq>${u === "/" ? "weekly" : "monthly"}</changefreq>`);
    lines.push(`    <priority>${u === "/" ? "1.0" : "0.7"}</priority>`);
    lines.push("  </url>");
  }
  lines.push("</urlset>");
  return lines.join("\n") + "\n";
}

// CLI entry: write to dist/sitemap.xml when invoked directly
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const outDir = path.join(ROOT, "dist");
  fs.mkdirSync(outDir, { recursive: true });
  const xml = buildSitemapXml();
  fs.writeFileSync(path.join(outDir, "sitemap.xml"), xml, "utf8");
  console.log(`sitemap: ${xml.split("\n").length - 2} entries`);
}
