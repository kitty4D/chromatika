import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BUILD_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * static-html mockup build for marketing/docs embeds.
 *
 * separate from vite.preview.config.ts (the dev-mode harness, served via `preview:ui`).
 * this config emits one self-contained HTML per screen under `preview-dist/`, intended
 * to be iframe-embedded on a marketing page. screens are NON-INTERACTIVE - clicks no-op,
 * no real trpc calls fire, no chrome.* runtime is required. animations still play
 * because the real chromatika react components ship in the bundle and react's mount
 * lifecycle fires entrance animations naturally (CSS keyframes, framer-motion
 * `initial`/`animate`, etc).
 *
 * Two substitutions strip the heavy machinery at build time:
 *  1. `@/lib/trpc` -> `./trpc-mock.ts`. Any `trpc.X.query(...)` resolves from the
 *     fixture registry (`./fixtures/registry.ts`). Procedures without a registered
 *     fixture log a warning and return null. Tree-shaking drops `@/server/router`
 *     because nothing else imports it at runtime, which in turn drops the entire
 *     background graph (@ika.xyz/sdk, @mysten/sui, ledger libs, vault crypto, etc).
 *  2. `chrome-stub.ts` (imported for side-effect at the top of every entry) installs
 *     a recursive Proxy as `globalThis.chrome` so any `chrome.storage.onChanged.add
 *     Listener(...)` etc inside hooks like `use-ika-base-mode` no-ops cleanly instead
 *     of throwing on missing namespaces (real Chrome browsers expose a partial chrome
 *     object on every page without the extension APIs).
 *
 * how a layout change in the real wallet propagates: edit src/ui/<Whatever>Page.tsx,
 * rerun `pnpm run preview:build`. emitted HTML reflects the change. no preview-side
 * edit needed UNLESS the component starts calling a new trpc procedure (add a fixture
 * entry to `./fixtures/registry.ts`) or reads a new chrome.storage key the stub
 * doesn't already cover.
 */
export default defineConfig({
  configFile: false,
  root: BUILD_ROOT,
  publicDir: resolve(REPO_ROOT, 'public'),
  // emit relative asset paths so the bundle is portable: serves correctly when copied
  // to any subpath (e.g. website/public/wallet-live/) without re-running the build.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      // alias the trpc client to our fixture-backed mock - tree-shakes the entire
      // background graph (@ika.xyz/sdk, @mysten/sui, ledger libs, vault crypto, etc.)
      // because nothing else imports `@/server/router` runtime
      '@/lib/trpc': resolve(BUILD_ROOT, 'trpc-mock.ts'),
      // pages that crash or stall in static preview (real chain reads, signing, real
      // chrome.storage etc) are swapped for placeholder UI explaining "not available
      // in live preview". the real modules ship in the actual extension bundle.
      '@/ui/pages/IkaStakingPage': resolve(BUILD_ROOT, 'preview-placeholder-page.tsx'),
      '@/ui/pages/ChromaLabPage': resolve(BUILD_ROOT, 'preview-placeholder-page.tsx'),
      '@/ui/pages/PaymentsPage': resolve(BUILD_ROOT, 'preview-placeholder-page.tsx'),
      '@/ui/pages/AgentsPage': resolve(BUILD_ROOT, 'preview-placeholder-page.tsx'),
      '@/ui/pages/PolicyVaultPage': resolve(BUILD_ROOT, 'preview-placeholder-page.tsx'),
      '@/ui/pages/VaultManagementScreen': resolve(BUILD_ROOT, 'preview-placeholder-page.tsx'),
      '@/ui/pages/DWalletManagementScreen': resolve(BUILD_ROOT, 'preview-placeholder-page.tsx'),
      // drawer strip becomes a "disabled-tooltip" version: shows the same four buttons
      // but clicking any of them surfaces "X - not available in live preview" instead
      // of trying to setTab('ikaStake') etc.
      '@/ui/components/WalletChromeIkaLabStrip': resolve(BUILD_ROOT, 'preview-drawer.tsx'),
      '@': resolve(REPO_ROOT, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  define: {
    global: 'globalThis',
    __CHROMATIKA_BUILD_STAMP__: JSON.stringify(`preview-${new Date().toISOString()}`),
    // surface the Solana ika base mode toggle in the title bar so visitors see both
    // mode pills (the gate is otherwise off in production-style builds).
    'import.meta.env.VITE_SOLANA_IKA_BASE': JSON.stringify('true'),
    __CHROMATIKA_PREVIEW_IFRAME__: JSON.stringify(true),
  },
  build: {
    outDir: resolve(REPO_ROOT, 'preview-dist'),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: true,
    rollupOptions: {
      input: {
        onboarding: resolve(BUILD_ROOT, 'onboarding.html'),
        assets: resolve(BUILD_ROOT, 'assets.html'),
        activity: resolve(BUILD_ROOT, 'activity.html'),
        send: resolve(BUILD_ROOT, 'send.html'),
        'vault-home': resolve(BUILD_ROOT, 'vault-home.html'),
        dwallets: resolve(BUILD_ROOT, 'dwallets.html'),
      },
      treeshake: true,
    },
  },
});
