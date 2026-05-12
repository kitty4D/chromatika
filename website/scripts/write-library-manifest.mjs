/**
 * scans library markdown dirs and writes `src/data/library-manifest.json`
 * so the site nav + search do not eagerly bundle every `.md` body into the entry chunk.
 * run standalone: node website/scripts/write-library-manifest.mjs
 * invoked at end of rewrite-library-md-links.mjs (spawn) and before vite via package.json scripts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, "..");
const USER_DIR = path.join(ROOT, "src", "library", "user-guides");
const TECH_DIR = path.join(ROOT, "src", "library", "tech-guides");
const OUT = path.join(ROOT, "src", "data", "library-manifest.json");

function listMd(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
}

function slugFromFilename(name) {
  return name.replace(/\.md$/i, "").toLowerCase();
}

function readDocTitle(absPath, fallbackSlug) {
  const raw = fs.readFileSync(absPath, "utf8");
  const firstLine = raw.split("\n")[0]?.trim() ?? "";
  if (firstLine.startsWith("# ")) return firstLine.slice(2).trim();
  return fallbackSlug;
}

function entriesFor(dir) {
  const out = [];
  for (const file of listMd(dir)) {
    const slug = slugFromFilename(file);
    const fp = path.join(dir, file);
    out.push({ slug, title: readDocTitle(fp, slug) });
  }
  return out;
}

function main() {
  const manifest = {
    user: entriesFor(USER_DIR),
    tech: entriesFor(TECH_DIR),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log("wrote library manifest:", path.relative(ROOT, OUT));
}

main();
