import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const BUILD_ROOT = resolve(REPO_ROOT, 'preview/build');

/** standalone vite serve for the preview harness — skips vite-plugin-web-extension so dev mode works.
 *  also serves the iframe-build entries under preview/build/* with the same trpc-mock + chrome-stub
 *  aliases used by the static build, so HMR works for the full main shell (vault-home, send, etc).
 */
export default defineConfig({
  root: resolve(REPO_ROOT, 'preview'),
  publicDir: resolve(REPO_ROOT, 'public'),
  plugins: [react()],
  resolve: {
    alias: {
      // mirror preview/build/vite.preview-build.config.ts so @/lib/trpc resolves to the
      // fixture mock (otherwise pages would try to talk to chrome.runtime which doesn't
      // exist in dev preview).
      '@/lib/trpc': resolve(BUILD_ROOT, 'trpc-mock.ts'),
      // page placeholders are kept for the iframe-build config (preview-build) where
      // these pages crash on real chain reads. in dev preview we mount them directly so
      // their visual styling can be iterated; trpc-mock returns null for unfixured procs
      // so the pages fall into their own empty/loading paths.
      // (VaultManagementScreen + DWalletManagementScreen still placeholder — they trigger
      // chrome.runtime password-prompt flows that aren't visual-styling targets.)
      '@/ui/pages/VaultManagementScreen': resolve(BUILD_ROOT, 'preview-placeholder-page.tsx'),
      '@/ui/pages/DWalletManagementScreen': resolve(BUILD_ROOT, 'preview-placeholder-page.tsx'),
      '@/ui/components/WalletChromeIkaLabStrip': resolve(BUILD_ROOT, 'preview-drawer.tsx'),
      '@': resolve(REPO_ROOT, 'src'),
    },
    dedupe: ['@mysten/sui', '@ika.xyz/sdk'],
  },
  define: {
    global: 'globalThis',
    __CHROMATIKA_BUILD_STAMP__: JSON.stringify('preview'),
    'import.meta.env.VITE_SOLANA_IKA_BASE': JSON.stringify('true'),
    __CHROMATIKA_PREVIEW_IFRAME__: JSON.stringify(true),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
