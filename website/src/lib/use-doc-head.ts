import { useEffect } from "react";
import {
  absoluteSiteUrl,
  DEFAULT_OG_IMAGE_ALT,
  DEFAULT_OG_IMAGE_PATH,
  DEFAULT_SITE_DESCRIPTION,
  HOME_DOCUMENT_TITLE,
  SITE_ORIGIN,
} from "./site-seo";

const DEFAULT_TITLE = HOME_DOCUMENT_TITLE;
const DEFAULT_DESCRIPTION = DEFAULT_SITE_DESCRIPTION;

/** Per-route metadata. Pass undefined fields to fall back to defaults. */
export type DocHead = {
  /** Page title shown in browser tab. Falls back to DEFAULT_TITLE (home / index). */
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
    const canonical = `${SITE_ORIGIN}${path}`;

    document.title = t;
    setMeta("description", d);
    setMeta("og:title", t, true);
    setMeta("og:description", d, true);
    setMeta("og:url", canonical, true);
    setMeta("og:locale", "en_US", true);
    setMeta("twitter:card", "summary_large_image");
    setMeta("twitter:title", t);
    setMeta("twitter:description", d);
    const ogImageAbs = absoluteSiteUrl(DEFAULT_OG_IMAGE_PATH);
    setMeta("og:image", ogImageAbs, true);
    setMeta("og:image:secure_url", ogImageAbs, true);
    setMeta("og:image:type", "image/png", true);
    setMeta("og:image:width", "1200", true);
    setMeta("og:image:height", "630", true);
    setMeta("og:image:alt", DEFAULT_OG_IMAGE_ALT, true);
    setMeta("twitter:image", ogImageAbs);
    setMeta("twitter:image:alt", DEFAULT_OG_IMAGE_ALT);
    setLink("canonical", canonical);
    setJsonLd(jsonLd);
  }, [title, description, canonicalPath, jsonLd]);
}
