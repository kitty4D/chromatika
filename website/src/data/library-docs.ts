export type LibraryKind = "user" | "tech";

export type LibraryNavItem = { slug: string; title: string };

type LibraryEntry = { title: string; bodyMd: string };

const userRaw = import.meta.glob<string>("../library/user-guides/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const techRaw = import.meta.glob<string>("../library/tech-guides/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function buildLibrary(rawMap: Record<string, string>): Map<string, LibraryEntry> {
  const bySlug = new Map<string, LibraryEntry>();
  for (const [path, raw] of Object.entries(rawMap)) {
    const slug = path.split(/[/\\]/).pop()!.replace(/\.md$/i, "").toLowerCase();
    const lines = raw.split("\n");
    let title = slug;
    let start = 0;
    if (lines[0]?.startsWith("# ")) {
      title = lines[0].slice(2).trim();
      start = 1;
      while (start < lines.length && lines[start].trim() === "") start++;
    }
    const bodyMd = lines.slice(start).join("\n");
    bySlug.set(slug, { title, bodyMd });
  }
  return bySlug;
}

const userLib = buildLibrary(userRaw);
const techLib = buildLibrary(techRaw);

function libMap(kind: LibraryKind): Map<string, LibraryEntry> {
  return kind === "user" ? userLib : techLib;
}

export function getLibraryBody(kind: LibraryKind, slug: string): string | undefined {
  return libMap(kind).get(slug)?.bodyMd;
}

export function getLibraryTitle(kind: LibraryKind, slug: string): string | undefined {
  return libMap(kind).get(slug)?.title;
}

export function libraryDocExists(kind: LibraryKind, slug: string): boolean {
  return libMap(kind).has(slug);
}

function compareNav(a: LibraryNavItem, b: LibraryNavItem): number {
  if (a.slug === "readme") return -1;
  if (b.slug === "readme") return 1;
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

export function listLibraryNav(kind: LibraryKind): LibraryNavItem[] {
  const m = libMap(kind);
  const items: LibraryNavItem[] = [];
  for (const [slug, { title }] of m) {
    items.push({ slug, title });
  }
  items.sort(compareNav);
  return items;
}

export type LibrarySearchHit = {
  kind: "lib-user" | "lib-tech";
  slug: string;
  title: string;
  summary: string;
  href: string;
};

const librarySearchCache: LibrarySearchHit[] = (() => {
  const out: LibrarySearchHit[] = [];
  for (const { slug, title } of listLibraryNav("user")) {
    out.push({
      kind: "lib-user",
      slug,
      title,
      summary: "user guide library (markdown)",
      href: `/library/user/${slug}`,
    });
  }
  for (const { slug, title } of listLibraryNav("tech")) {
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
      h.summary.toLowerCase().includes(n)
  );
}
