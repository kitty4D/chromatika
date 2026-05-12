export type LibraryKind = "user" | "tech";

export type LibraryNavItem = { slug: string; title: string };

export type LibrarySearchHit = {
  kind: "lib-user" | "lib-tech";
  slug: string;
  title: string;
  summary: string;
  href: string;
};
