/**
 * single source of truth for "which routes exist" + "what metadata each route gets baked into HTML".
 *
 * consumed by:
 *   - scripts/build-sitemap.mjs (uses enumerateRoutes() to write sitemap.xml urls)
 *   - vite.config.ts htmlBakePlugin (uses both to write per-route static index.html with proper head tags)
 *
 * runtime metadata (src/lib/use-doc-head.ts + per-component useDocHead calls) MUST stay in sync with
 * what we return here, otherwise the static HTML shipped to non-JS clients (twitter, discord, slack,
 * linkedin, search-engine first crawl) will disagree with what the SPA renders after JS hydrates.
 *
 * sources of truth this module reads:
 *   - src/lib/site-seo.ts: SITE_ORIGIN, default title, default description, default OG image
 *   - src/data/kb.ts: KB categories + articles (regex-parsed; mirrors readSlugList / readCategoryIds)
 *   - src/library/{user,tech}-guides/*.md: title from first H1, description from first paragraph
 *   - hardcoded blocks below for static routes: /, /knowledge-base, /library, /library/user,
 *     /library/tech, /legal/privacy, /legal/terms (mirror what each component passes to useDocHead)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function readSiteSeoConsts() {
  const p = path.join(ROOT, "src", "lib", "site-seo.ts");
  const text = fs.readFileSync(p, "utf8");
  const origin = text.match(/export const SITE_ORIGIN = "([^"]+)"/)?.[1];
  const homeTitle = text.match(/export const HOME_DOCUMENT_TITLE = "([^"]+)"/)?.[1];
  const defaultDesc = text.match(/export const DEFAULT_SITE_DESCRIPTION =\s*\n?\s*"([^"]+)"/)?.[1];
  const ogPath = text.match(/export const DEFAULT_OG_IMAGE_PATH = "([^"]+)"/)?.[1];
  const ogAlt = text.match(/export const DEFAULT_OG_IMAGE_ALT =\s*\n?\s*"([^"]+)"/)?.[1];
  if (!origin || !homeTitle || !defaultDesc || !ogPath || !ogAlt) {
    throw new Error(`route-meta: failed to parse site-seo.ts at ${p}`);
  }
  return {
    SITE_ORIGIN: origin.replace(/\/+$/, ""),
    HOME_DOCUMENT_TITLE: homeTitle,
    DEFAULT_SITE_DESCRIPTION: defaultDesc,
    DEFAULT_OG_IMAGE_PATH: ogPath,
    DEFAULT_OG_IMAGE_ALT: ogAlt,
  };
}

const SEO = readSiteSeoConsts();

function pageTitle(routeLabel) {
  // mirrors useDocHead: route titles get suffixed " - Chromatika"; root uses HOME_DOCUMENT_TITLE.
  if (routeLabel == null) return SEO.HOME_DOCUMENT_TITLE;
  return `${routeLabel} - Chromatika`;
}

function absoluteUrl(p) {
  if (p.startsWith("http://") || p.startsWith("https://")) return p;
  return `${SEO.SITE_ORIGIN}${p.startsWith("/") ? p : `/${p}`}`;
}

/** parse src/data/kb.ts for category ids + labels + blurbs */
function readKbCategories() {
  const text = fs.readFileSync(path.join(ROOT, "src", "data", "kb.ts"), "utf8");
  const start = text.indexOf("kbCategories");
  const end = text.indexOf("kbArticles");
  if (start < 0 || end < 0) {
    throw new Error("route-meta: could not slice kbCategories block from kb.ts");
  }
  const slice = text.slice(start, end);
  const out = [];
  const re =
    /\{\s*id:\s*"([a-z0-9_-]+)"\s*,\s*label:\s*"([^"]+)"\s*,\s*blurb:\s*(?:"([^"]+)"|\s*"([^"]+)"\s*)\s*,?\s*\}/gi;
  let m;
  while ((m = re.exec(slice)) !== null) {
    out.push({ id: m[1], label: m[2], blurb: m[3] || m[4] || "" });
  }
  return out;
}

/** parse src/data/kb.ts for article slug + title + categoryId + summary */
function readKbArticles() {
  const text = fs.readFileSync(path.join(ROOT, "src", "data", "kb.ts"), "utf8");
  const start = text.indexOf("kbArticles");
  if (start < 0) {
    throw new Error("route-meta: could not find kbArticles block in kb.ts");
  }
  const slice = text.slice(start);
  // pull article objects one at a time; tolerate multiline summary strings
  const out = [];
  // matches: { slug: "...", title: "...", categoryId: "...", summary: "..." or summary:\n      "..."
  const re =
    /\{\s*slug:\s*"([a-z0-9_-]+)"\s*,\s*title:\s*"([^"]+)"\s*,\s*categoryId:\s*"([a-z0-9_-]+)"\s*,\s*summary:\s*\n?\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(slice)) !== null) {
    out.push({ slug: m[1], title: m[2], categoryId: m[3], summary: m[4] });
  }
  return out;
}

/** read first H1 + first paragraph from a markdown file */
function readMarkdownMeta(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  let title = null;
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && lines[i].startsWith("# ")) {
    title = lines[i].slice(2).trim();
    i++;
  }
  while (i < lines.length && lines[i].trim() === "") i++;
  // first paragraph: contiguous non-blank lines that aren't a heading or list item
  const paraLines = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") break;
    if (line.startsWith("#")) break;
    if (line.startsWith("- ") || line.startsWith("* ")) break;
    paraLines.push(line);
  }
  let description = paraLines.join(" ").replace(/\s+/g, " ").trim();
  // strip markdown link syntax to plain text for description: [foo](bar) -> foo
  description = description.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // strip emphasis markers (* _ `)
  description = description.replace(/(\*\*|__|\*|_|`)/g, "");
  if (description.length > 160) {
    description = description.slice(0, 157).trimEnd() + "...";
  }
  return { title, description };
}

function listLibrarySlugs(kindDir) {
  return fs
    .readdirSync(path.join(ROOT, "src", "library", kindDir))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/i, "").toLowerCase());
}

function libraryMeta(kind, slug) {
  const dir = kind === "user" ? "user-guides" : "tech-guides";
  // filename casing on disk varies (e.g. README.md); try both
  const candidates = [
    path.join(ROOT, "src", "library", dir, `${slug}.md`),
    path.join(ROOT, "src", "library", dir, `${slug.toUpperCase()}.md`),
  ];
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) return null;
  return readMarkdownMeta(filePath);
}

const STATIC_ROUTE_META = new Map([
  [
    "/",
    {
      title: null, // home uses HOME_DOCUMENT_TITLE bare (no " - Chromatika" suffix)
      description: SEO.DEFAULT_SITE_DESCRIPTION,
      canonicalPath: "/",
    },
  ],
  [
    "/knowledge-base",
    {
      title: "knowledge base",
      description:
        "Short themed articles on Chromatika: onboarding, identity, vault security, chains, hardware, and product status.",
      canonicalPath: "/knowledge-base",
    },
  ],
  [
    "/library",
    {
      title: "guides library",
      description:
        "Entry point for Chromatika markdown guides: user guides and tech guides indices. Prefer the top navigation for browsing.",
      canonicalPath: "/library",
    },
  ],
  [
    "/library/user",
    {
      title: "user guides",
      description:
        "Chromatika user guides: task-style markdown reference for onboarding, vaults, dWallets, sends, hardware, chains, and advanced surfaces.",
      canonicalPath: "/library/user",
    },
  ],
  [
    "/library/tech",
    {
      title: "tech guides",
      description:
        "Chromatika tech guides: deep technical notes on crypto, ika, the dapp bridge, Chrome APIs, and integrations.",
      canonicalPath: "/library/tech",
    },
  ],
  [
    "/legal/privacy",
    {
      title: "privacy policy",
      description:
        "Chromatika's privacy stance for the public knowledge base and the wallet extension.",
      canonicalPath: "/legal/privacy",
    },
  ],
  [
    "/legal/terms",
    {
      title: "terms of service",
      description:
        "Terms of use for the Chromatika public knowledge base and the wallet extension.",
      canonicalPath: "/legal/terms",
    },
  ],
]);

/** returns sorted list of every canonical route URL the site serves. */
export function enumerateRoutes() {
  const urls = new Set(STATIC_ROUTE_META.keys());
  for (const cat of readKbCategories()) {
    urls.add(`/category/${cat.id}`);
  }
  for (const art of readKbArticles()) {
    urls.add(`/article/${art.slug}`);
  }
  for (const slug of listLibrarySlugs("user-guides")) {
    urls.add(`/library/user/${slug}`);
  }
  for (const slug of listLibrarySlugs("tech-guides")) {
    urls.add(`/library/tech/${slug}`);
  }
  return Array.from(urls).sort();
}

/**
 * returns metadata for a route: { fullTitle, description, canonical, ogImageAbs, ogImageAlt, jsonLd? }
 * fullTitle is the exact `<title>` text (already includes " - Chromatika" suffix where appropriate).
 * canonical is the absolute URL.
 * returns null if the route isn't recognized.
 */
export function getRouteMeta(routePath) {
  const ogImageAbs = absoluteUrl(SEO.DEFAULT_OG_IMAGE_PATH);
  const ogImageAlt = SEO.DEFAULT_OG_IMAGE_ALT;

  // static routes
  if (STATIC_ROUTE_META.has(routePath)) {
    const m = STATIC_ROUTE_META.get(routePath);
    return {
      fullTitle: pageTitle(m.title),
      description: m.description,
      canonical: absoluteUrl(m.canonicalPath),
      ogImageAbs,
      ogImageAlt,
      jsonLd: null,
    };
  }

  // /category/:id
  let m = routePath.match(/^\/category\/([a-z0-9_-]+)$/i);
  if (m) {
    const cat = readKbCategories().find((c) => c.id === m[1]);
    if (!cat) return null;
    return {
      fullTitle: pageTitle(cat.label),
      description: cat.blurb,
      canonical: absoluteUrl(`/category/${cat.id}`),
      ogImageAbs,
      ogImageAlt,
      jsonLd: null,
    };
  }

  // /article/:slug
  m = routePath.match(/^\/article\/([a-z0-9_-]+)$/i);
  if (m) {
    const arts = readKbArticles();
    const cats = readKbCategories();
    const art = arts.find((a) => a.slug === m[1]);
    if (!art) return null;
    const cat = cats.find((c) => c.id === art.categoryId);
    return {
      fullTitle: pageTitle(art.title),
      description: art.summary,
      canonical: absoluteUrl(`/article/${art.slug}`),
      ogImageAbs,
      ogImageAlt,
      jsonLd: cat
        ? {
            "@context": "https://schema.org",
            "@type": "Article",
            headline: art.title,
            description: art.summary,
            articleSection: cat.label,
            author: { "@type": "Organization", name: "Chromatika" },
            publisher: { "@type": "Organization", name: "Chromatika" },
          }
        : null,
    };
  }

  // /library/user/:slug
  m = routePath.match(/^\/library\/(user|tech)\/([a-z0-9_-]+)$/i);
  if (m) {
    const kind = m[1];
    const slug = m[2].toLowerCase();
    const meta = libraryMeta(kind, slug);
    if (!meta) return null;
    const sectionLabel = kind === "user" ? "user guides" : "tech guides";
    const title = meta.title ?? slug;
    const description =
      meta.description && meta.description.length > 0
        ? meta.description
        : `${sectionLabel}: ${title} - chromatika library reference.`;
    return {
      fullTitle: pageTitle(title),
      description,
      canonical: absoluteUrl(`/library/${kind}/${slug}`),
      ogImageAbs,
      ogImageAlt,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: title,
        description,
        articleSection: sectionLabel,
        author: { "@type": "Organization", name: "Chromatika" },
        publisher: { "@type": "Organization", name: "Chromatika" },
      },
    };
  }

  return null;
}

export const SITE_ORIGIN = SEO.SITE_ORIGIN;
