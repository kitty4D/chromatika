import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** standalone vite serve for the preview harness — skips vite-plugin-web-extension so dev mode works */
export default defineConfig({
  root: resolve(REPO_ROOT, 'preview'),
  publicDir: resolve(REPO_ROOT, 'public'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(REPO_ROOT, 'src'),
    },
    dedupe: ['@mysten/sui', '@ika.xyz/sdk'],
  },
  define: {
    global: 'globalThis',
    __CHROMATIKA_BUILD_STAMP__: JSON.stringify('preview'),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
