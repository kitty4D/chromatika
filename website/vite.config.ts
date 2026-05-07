import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { buildSitemapXml } from "./scripts/build-sitemap.mjs";
import { enumerateRoutes, getRouteMeta } from "./scripts/route-meta.mjs";

function sitemapPlugin() {
  return {
    name: "chromatika-sitemap",
    apply: "build" as const,
    closeBundle() {
      const outDir = path.resolve(__dirname, "dist");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "sitemap.xml"), buildSitemapXml(), "utf8");
    },
  };
}

/**
 * after vite build, walk every known route from route-meta.mjs and write a per-route
 * dist/<route>/index.html with baked-in <title> / meta description / canonical / og /
 * twitter / json-ld. body is identical to dist/index.html (same root + same JS entry),
 * so the React SPA hydrates normally for users. the bake exists purely so non-JS clients
 * (twitter, discord, slack, linkedin, search-engine first crawl) see correct per-page
 * head tags instead of the home-page defaults. vercel serves these files directly because
 * they exist on disk; the SPA fallback in vercel.json catches any unbaked path.
 */
function htmlBakePlugin() {
  return {
    name: "chromatika-html-bake",
    apply: "build" as const,
    closeBundle() {
      const outDir = path.resolve(__dirname, "dist");
      const shellPath = path.join(outDir, "index.html");
      const shell = fs.readFileSync(shellPath, "utf8");

      const routes = enumerateRoutes();
      let baked = 0;
      let skipped = 0;
      for (const route of routes) {
        if (route === "/") continue; // dist/index.html already serves "/"
        const meta = getRouteMeta(route);
        if (!meta) {
          skipped++;
          continue;
        }
        const html = applyHeadOverrides(shell, meta);
        const dir = path.join(outDir, route.replace(/^\//, ""));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
        baked++;
      }
      console.log(
        `html-bake: ${baked} per-route HTML files written` +
          (skipped > 0 ? ` (${skipped} routes had no metadata)` : "")
      );
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface BakedRouteMeta {
  fullTitle: string;
  description: string;
  canonical: string;
  ogImageAbs: string;
  ogImageAlt: string;
  jsonLd: Record<string, unknown> | null;
}

function applyHeadOverrides(shell: string, meta: BakedRouteMeta): string {
  let html = shell;
  const title = escapeHtml(meta.fullTitle);
  const desc = escapeHtml(meta.description);
  const canonical = escapeHtml(meta.canonical);
  const ogImage = escapeHtml(meta.ogImageAbs);
  const ogImageAlt = escapeHtml(meta.ogImageAlt);

  // <title>
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`);

  // <meta name="description">
  html = upsertMeta(html, { attr: "name", key: "description", content: desc });

  // og + twitter pairs
  html = upsertMeta(html, { attr: "property", key: "og:title", content: title });
  html = upsertMeta(html, { attr: "property", key: "og:description", content: desc });
  html = upsertMeta(html, { attr: "property", key: "og:url", content: canonical });
  html = upsertMeta(html, { attr: "property", key: "og:image", content: ogImage });
  html = upsertMeta(html, { attr: "property", key: "og:image:secure_url", content: ogImage });
  html = upsertMeta(html, { attr: "property", key: "og:image:alt", content: ogImageAlt });
  html = upsertMeta(html, { attr: "name", key: "twitter:title", content: title });
  html = upsertMeta(html, { attr: "name", key: "twitter:description", content: desc });
  html = upsertMeta(html, { attr: "name", key: "twitter:image", content: ogImage });
  html = upsertMeta(html, { attr: "name", key: "twitter:image:alt", content: ogImageAlt });

  // canonical link: insert before </head> if not present, else replace existing.
  const canonicalTag = `<link rel="canonical" href="${canonical}" />`;
  if (/<link\s+rel=["']canonical["'][^>]*>/i.test(html)) {
    html = html.replace(/<link\s+rel=["']canonical["'][^>]*>/i, canonicalTag);
  } else {
    html = html.replace(/<\/head>/i, `    ${canonicalTag}\n  </head>`);
  }

  // strip the home-page WebSite JSON-LD from non-home pages so per-route Article ld can
  // be the only one for that URL (avoids duplicate WebSite blocks on every page).
  html = html.replace(
    /<script\s+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>\s*/i,
    ""
  );

  // optional Article json-ld
  if (meta.jsonLd) {
    const jsonLdTag = `<script type="application/ld+json">${JSON.stringify(meta.jsonLd)}</script>`;
    html = html.replace(/<\/head>/i, `    ${jsonLdTag}\n  </head>`);
  }

  return html;
}

function upsertMeta(
  html: string,
  { attr, key, content }: { attr: "name" | "property"; key: string; content: string }
): string {
  const re = new RegExp(`<meta\\s+${attr}=["']${key}["'][^>]*>`, "i");
  const tag = `<meta ${attr}="${key}" content="${content}" />`;
  if (re.test(html)) return html.replace(re, tag);
  return html.replace(/<\/head>/i, `    ${tag}\n  </head>`);
}

export default defineConfig({
  plugins: [react(), sitemapPlugin(), htmlBakePlugin()],
  server: {
    port: 5175,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("react-router")) return "vendor-router";
          if (id.includes("react-markdown") || id.includes("remark-")) return "vendor-markdown";
          if (id.includes("react-dom") || id.includes("/react/")) return "vendor-react";
          return undefined;
        },
      },
    },
  },
});
