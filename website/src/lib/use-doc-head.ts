import { useEffect } from "react";

const DEFAULT_TITLE = "Chromatika: knowledge base";
const DEFAULT_DESCRIPTION =
  "Chromatika site: user guides, tech guides, and a knowledge base for this dWallet-first multi-chain browser wallet.";
const SITE_URL = "https://chromatika.dev";

/** Per-route metadata. Pass undefined fields to fall back to defaults. */
export type DocHead = {
  /** Page title shown in browser tab. Falls back to "Chromatika: knowledge base". */
  title?: string;
  /** Meta description (under ~160 chars). Falls back to a generic site description. */
  description?: string;
  /** Path to canonicalize against. If omitted, uses window.location.pathname. */
  canonicalPath?: string;
  /** Optional JSON-LD structured-data object (e.g. Article, Breadcrumbs). Object-shaped. */
  jsonLd?: Record<string, unknown> | null;
};

function setMeta(name: string, content: string, useProperty = false) {
  const attr = useProperty ? "property" : "name";
  const selector = useProperty ? `meta[property="${name}"]` : `meta[name="${name}"]`;
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setLink(rel: string, href: string) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"][data-doc-head]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    el.setAttribute("data-doc-head", "");
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

function setJsonLd(payload: Record<string, unknown> | null | undefined) {
  document.head
    .querySelectorAll('script[type="application/ld+json"][data-doc-head]')
    .forEach((n) => n.remove());
  if (!payload) return;
  const script = document.createElement("script");
  script.setAttribute("type", "application/ld+json");
  script.setAttribute("data-doc-head", "");
  script.textContent = JSON.stringify(payload);
  document.head.appendChild(script);
}

/** Updates document.title, meta description, OG/Twitter pairs, canonical link, and optional JSON-LD on mount + when fields change. */
export function useDocHead(head: DocHead): void {
  const { title, description, canonicalPath, jsonLd } = head;
  useEffect(() => {
    const t = title ? `${title} - Chromatika` : DEFAULT_TITLE;
    const d = description ?? DEFAULT_DESCRIPTION;
    const path = canonicalPath ?? window.location.pathname;
    const canonical = `${SITE_URL}${path}`;

    document.title = t;
    setMeta("description", d);
    setMeta("og:title", t, true);
    setMeta("og:description", d, true);
    setMeta("og:url", canonical, true);
    setMeta("twitter:title", t);
    setMeta("twitter:description", d);
    setLink("canonical", canonical);
    setJsonLd(jsonLd);
  }, [title, description, canonicalPath, jsonLd]);
}
