/**
 * rewrites in-repo .md links inside copied library docs to chromatika website routes.
 * run from repo: node website/scripts/rewrite-library-md-links.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, "..");
const USER_DIR = path.join(ROOT, "src", "library", "user-guides");
const TECH_DIR = path.join(ROOT, "src", "library", "tech-guides");

const USER_BASE = "/library/user/";
const TECH_BASE = "/library/tech/";

function listMd(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
}

function slugFromFilename(name) {
  return name.replace(/\.md$/i, "").toLowerCase();
}

const userSlugs = new Set(listMd(USER_DIR).map(slugFromFilename));
const techSlugs = new Set(listMd(TECH_DIR).map(slugFromFilename));

function targetForSlug(slug, mode) {
  if (mode === "user" && userSlugs.has(slug)) return USER_BASE + slug;
  if (mode === "tech" && techSlugs.has(slug)) return TECH_BASE + slug;
  if (mode === "user" && techSlugs.has(slug)) return TECH_BASE + slug;
  if (mode === "tech" && userSlugs.has(slug)) return USER_BASE + slug;
  return (mode === "user" ? USER_BASE : TECH_BASE) + slug;
}

/** @param {string} content @param {'user' | 'tech'} mode */
function rewrite(content, mode) {
  const sameBase = mode === "user" ? USER_BASE : TECH_BASE;

  let out = content;

  out = out.replace(/\]\(\s*\.\/([a-z0-9][a-z0-9_-]*\.md)\s*\)/gi, (_, f) => {
    const s = slugFromFilename(f);
    return `](${targetForSlug(s, mode)})`;
  });
  out = out.replace(/\]\(\s*([a-z0-9][a-z0-9_-]*\.md)\s*\)/gi, (_, f) => {
    const s = slugFromFilename(f);
    return `](${targetForSlug(s, mode)})`;
  });

  out = out.replace(
    /\]\(\s*[^)]*wallet-userguides[\\/]+([a-z0-9][a-z0-9_-]*\.md)\s*\)/gi,
    (_, f) => `](${USER_BASE}${slugFromFilename(f)})`
  );
  out = out.replace(
    /\]\(\s*[^)]*wallet-techguides[\\/]+([a-z0-9][a-z0-9_-]*\.md)\s*\)/gi,
    (_, f) => `](${TECH_BASE}${slugFromFilename(f)})`
  );

  out = out.replace(/`([a-z0-9][a-z0-9_-]*\.md)`/gi, (_, f) => {
    const s = slugFromFilename(f);
    const href = targetForSlug(s, mode);
    return `[${f}](${href})`;
  });

  return out;
}

function patchReadmeIntro(content, kind) {
  let out = content;
  if (kind === "user") {
    out = out.replace(
      /these are personal docs \(the `local\/` folder is gitignored\)\. they'?re aimed at/gi,
      "these pages are published on the chromatika site alongside the extension; they are aimed at"
    );
  } else {
    out = out.replace(
      /these are personal docs \(the `local\/` folder is gitignored\)\. audience:/gi,
      "these pages are published on the chromatika site alongside the extension. audience:"
    );
    out = out.replace(
      /complement to `wallet-userguides\/` \(which describes \*\*what\*\* users can do\)\./gi,
      "complement to the [user guides](" + USER_BASE + "readme) (which describes **what** users can do)."
    );
  }
  return out;
}

function processDir(dir, mode) {
  for (const file of listMd(dir)) {
    const fp = path.join(dir, file);
    let text = fs.readFileSync(fp, "utf8");
    if (file.toLowerCase() === "readme.md") {
      text = patchReadmeIntro(text, mode);
    }
    text = rewrite(text, mode);
    fs.writeFileSync(fp, text, "utf8");
  }
}

processDir(USER_DIR, "user");
processDir(TECH_DIR, "tech");

console.log(
  "rewrote .md links in",
  listMd(USER_DIR).length,
  "user +",
  listMd(TECH_DIR).length,
  "tech files"
);
