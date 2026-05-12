import manifestJson from "./library-manifest.json";
import type { LibraryKind, LibraryNavItem, LibrarySearchHit } from "./library-types";

/** title + slug index for sidebar, search chips, existence checks — bodies load lazily. */
const manifest = manifestJson as { user: LibraryNavItem[]; tech: LibraryNavItem[] };

function navFor(kind: LibraryKind): LibraryNavItem[] {
  const rows = kind === "user" ? manifest.user : manifest.tech;
  return [...rows];
}

function compareNav(a: LibraryNavItem, b: LibraryNavItem): number {
  if (a.slug === "readme") return -1;
  if (b.slug === "readme") return 1;
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

/** strip leading markdown h1 + blank lines so MarkdownDoc avoids duplicate titles */
function stripLeadingTitle(md: string): string {
  const lines = md.split("\n");
  let start = 0;
  if (lines[0]?.startsWith("# ")) {
    start = 1;
    while (start < lines.length && lines[start]?.trim() === "") start++;
  }
  return lines.slice(start).join("\n");
}

const userModules = import.meta.glob<string>("../library/user-guides/*.md", {
  query: "?raw",
  import: "default",
  eager: false,
}) as Record<string, () => Promise<string>>;

const techModules = import.meta.glob<string>("../library/tech-guides/*.md", {
  query: "?raw",
  import: "default",
  eager: false,
}) as Record<string, () => Promise<string>>;

function buildSlugToLoader(
  mods: Record<string, () => Promise<string>>,
): Map<string, () => Promise<string>> {
  const m = new Map<string, () => Promise<string>>();
  for (const [p, loader] of Object.entries(mods)) {
    const slug = p.split(/[/\\]/).pop()!.replace(/\.md$/i, "").toLowerCase();
    m.set(slug, loader);
  }
  return m;
}

const userLoadBySlug = buildSlugToLoader(userModules);
const techLoadBySlug = buildSlugToLoader(techModules);

const bodyCache = new Map<string, string>();

function loaderFor(kind: LibraryKind, slug: string): (() => Promise<string>) | undefined {
  return kind === "user" ? userLoadBySlug.get(slug) : techLoadBySlug.get(slug);
}

export type { LibraryKind, LibraryNavItem, LibrarySearchHit } from "./library-types";

export function getLibraryNavRows(kind: LibraryKind): LibraryNavItem[] {
  return navFor(kind).sort(compareNav);
}

export function listLibraryNav(kind: LibraryKind): LibraryNavItem[] {
  return getLibraryNavRows(kind);
}

export function libraryDocExists(kind: LibraryKind, slug: string): boolean {
  return navFor(kind).some((row) => row.slug === slug);
}

export function getLibraryTitle(kind: LibraryKind, slug: string): string | undefined {
  return navFor(kind).find((row) => row.slug === slug)?.title;
}

export async function loadLibraryBody(kind: LibraryKind, slug: string): Promise<string | undefined> {
  const key = `${kind}:${slug}`;
  if (bodyCache.has(key)) return bodyCache.get(key)!;
  const load = loaderFor(kind, slug);
  if (!load) return undefined;
  const raw = await load();
  const body = stripLeadingTitle(raw);
  bodyCache.set(key, body);
  return body;
}

const librarySearchCache: LibrarySearchHit[] = (() => {
  const out: LibrarySearchHit[] = [];
  for (const { slug, title } of getLibraryNavRows("user")) {
    out.push({
      kind: "lib-user",
      slug,
      title,
      summary: "user guides markdown library",
      href: `/library/user/${slug}`,
    });
  }
  for (const { slug, title } of getLibraryNavRows("tech")) {
    out.push({
      kind: "lib-tech",
      slug,
      title,
      summary: "tech guide library (markdown)",
      href: `/library/tech/${slug}`,
    });
  }
  return out;
})();

export function filterLibrarySearch(needle: string): LibrarySearchHit[] {
  const n = needle.trim().toLowerCase();
  if (!n) return [];
  return librarySearchCache.filter(
    (h) =>
      h.title.toLowerCase().includes(n) ||
      h.slug.toLowerCase().includes(n) ||
      h.summary.toLowerCase().includes(n),
  );
}
