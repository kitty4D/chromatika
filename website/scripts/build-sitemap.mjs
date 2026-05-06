/**
 * builds dist/sitemap.xml from the website's route map.
 * runs as a vite plugin closeBundle hook (see vite.config.ts).
 *
 * sources of truth:
 *   - top-level routes: hardcoded list (Home, KB hub, library stub, markdown hubs, Legal)
 *   - KB categories + articles: regex over src/data/kb.ts
 *   - Library docs: fs glob over src/library/{user,tech}-guides/*.md
 *
 * site URL can be overridden via SITE_URL env var; otherwise syncs from src/lib/site-seo.ts (SITE_ORIGIN).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function readSiteOriginFromSiteSeo() {
  const p = path.join(ROOT, "src", "lib", "site-seo.ts");
  const text = fs.readFileSync(p, "utf8");
  const m = text.match(/export const SITE_ORIGIN = "([^"]+)"/);
  if (!m) {
    throw new Error(`SITE_ORIGIN not found in ${p}`);
  }
  return m[1].replace(/\/+$/, "");
}

const SITE_URL = (process.env.SITE_URL || readSiteOriginFromSiteSeo()).replace(/\/+$/, "");

function readSlugList(filePath, listToken) {
  const text = fs.readFileSync(filePath, "utf8");
  const slugs = [];
  const re = /slug:\s*"([a-z0-9][a-z0-9_-]*)"/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    slugs.push(m[1]);
  }
  return Array.from(new Set(slugs));
}

function readCategoryIds(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const ids = [];
  const re = /id:\s*"([a-z0-9][a-z0-9_-]*)"/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    ids.push(m[1]);
  }
  return Array.from(new Set(ids));
}

function listLibrarySlugs(kindDir) {
  return fs
    .readdirSync(path.join(ROOT, "src", "library", kindDir))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/i, "").toLowerCase());
}

export function buildSitemapXml() {
  const kbPath = path.join(ROOT, "src", "data", "kb.ts");

  const kbSlugs = readSlugList(kbPath, "articles");
  const kbCategoryIds = readCategoryIds(kbPath);
  const userLibSlugs = listLibrarySlugs("user-guides");
  const techLibSlugs = listLibrarySlugs("tech-guides");

  const today = new Date().toISOString().slice(0, 10);

  const urls = new Set();

  // top-level routes
  [
    "/",
    "/knowledge-base",
    "/library",
    "/library/user",
    "/library/tech",
    "/legal/privacy",
    "/legal/terms",
  ].forEach((u) => urls.add(u));

  kbCategoryIds.forEach((id) => urls.add(`/category/${id}`));
  kbSlugs.forEach((s) => urls.add(`/article/${s}`));
  userLibSlugs.forEach((s) => urls.add(`/library/user/${s}`));
  techLibSlugs.forEach((s) => urls.add(`/library/tech/${s}`));

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  for (const u of Array.from(urls).sort()) {
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
