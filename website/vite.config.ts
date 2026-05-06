import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { buildSitemapXml } from "./scripts/build-sitemap.mjs";

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

export default defineConfig({
  plugins: [react(), sitemapPlugin()],
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
