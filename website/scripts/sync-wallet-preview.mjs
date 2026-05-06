/**
 * Copies the wallet-extension's preview build output into website/public/wallet-live/
 * so the home-page iframe can serve real wallet UI screens at /wallet-live/<screen>.html.
 *
 * Source: wallet-extension/preview-dist/ (produced by `pnpm --dir wallet-extension run preview:build`)
 * Dest:   website/public/wallet-live/
 *
 * Behavior:
 *   - On Vercel (`VERCEL=1`), `--build` is ignored so deploy does not need
 *     wallet-extension/node_modules; use committed `public/wallet-live/` or sync locally.
 *   - If the source is missing without --build, log a hint and exit 0 (don't fail the website build).
 *   - Always rsync-style: empty the dest dir first, then copy everything fresh.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBSITE_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(WEBSITE_ROOT, "..");
const SRC_DIR = path.resolve(REPO_ROOT, "wallet-extension", "preview-dist");
const DEST_DIR = path.resolve(WEBSITE_ROOT, "public", "wallet-live");

const shouldBuild =
  process.env.VERCEL !== "1" &&
  (process.argv.includes("--build") || process.env.PREVIEW_BUILD === "1");

if (shouldBuild) {
  console.log("sync-wallet-preview: building wallet-extension preview...");
  const res = spawnSync("pnpm", ["--dir", "wallet-extension", "run", "preview:build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: true,
  });
  if (res.status !== 0) {
    console.error("sync-wallet-preview: wallet-extension preview build failed");
    process.exit(res.status ?? 1);
  }
}

if (!fs.existsSync(SRC_DIR)) {
  console.warn(`sync-wallet-preview: ${path.relative(REPO_ROOT, SRC_DIR)} not found`);
  console.warn("  run with --build to trigger the wallet-extension preview build first,");
  console.warn("  or run `pnpm --dir wallet-extension run preview:build` manually.");
  process.exit(0);
}

if (fs.existsSync(DEST_DIR)) {
  fs.rmSync(DEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DEST_DIR, { recursive: true });

let count = 0;
function copyRecursive(srcPath, destPath) {
  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    fs.mkdirSync(destPath, { recursive: true });
    for (const entry of fs.readdirSync(srcPath)) {
      copyRecursive(path.join(srcPath, entry), path.join(destPath, entry));
    }
  } else if (stat.isFile()) {
    fs.copyFileSync(srcPath, destPath);
    count++;
  }
}
copyRecursive(SRC_DIR, DEST_DIR);

console.log(
  `sync-wallet-preview: copied ${count} files from ${path.relative(REPO_ROOT, SRC_DIR)} -> ${path.relative(REPO_ROOT, DEST_DIR)}`
);
