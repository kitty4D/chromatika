# chromatika website

public knowledge base and user guide for Chromatika (static Vite + React). product and IA direction: **`DESIGN-BRIEF.md`**.

## after editing this package

run **lint**, **TypeScript**, and **Prettier** before you consider the task done:

```bash
pnpm run format    # apply prettier
pnpm run verify    # eslint (zero warnings) + tsc --noEmit + prettier --check
```

or one shot: `pnpm run format && pnpm run verify`.

## run

```bash
pnpm install
pnpm dev
```

## build

```bash
pnpm build
```

## routes (high level)

- `/`: landing + KB category cards + article index
- `/guide`: user guide hub (sidebar shell)
- `/guide/:slug`: individual guide article (media strip when `media` entries have `src`)
- `/category/:id`, `/article/:slug`: existing KB articles

guide screenshots and video assets can live under **`public/guide/assets/`** (see `.gitkeep`).

### logos (chain + partner marks)

Home page assets under **`public/logos/`** are **copies** of `wallet-extension/public/logos/*.svg` plus **`ika.svg`** from `wallet-extension/public/ika.svg`. When the extension adds or updates marks, re-copy those files (or add a small sync script) so the site stays aligned.

## embedding the “real” wallet UI on this site

A stock static deploy **cannot** run your MV3 bundle as-is: `chrome.*` APIs, extension origins, and unpacked-only assets are not available to normal `https://` pages, and `chrome-extension://…` iframes are not readable by random visitors.

Practical ways to stay “fresh” vs `wallet-extension/`:

1. **Keep the marketing mock** (`WalletVaultPreview`) and regenerate or restyle it when vault UX changes: lowest risk.
2. **Add a build step** that runs `pnpm -C ../wallet-extension build` and copies **non-sensitive** artifacts (e.g. hashed CSS chunks, SVGs) into `website/public/` for visuals only: still not the live app, but tokens and spacing can track the extension build.
3. **Standalone preview bundle**: a dedicated Vite entry in `wallet-extension/` that imports only presentational pieces with a **chrome shim** (mock `storage`, `runtime`, tRPC). Build it to `website/public/wallet-live/` and iframe it. This is real React code, but it is a separate compile and needs maintenance whenever imports touch the service worker boundary.
4. **Dev-only**: run the extension's dev server or open `dist/` in Chrome and point an iframe at a **local** URL you control: fine for authors, not for production.

There is no magic import that silently injects the full extension into the KB site without one of the above bridges.
