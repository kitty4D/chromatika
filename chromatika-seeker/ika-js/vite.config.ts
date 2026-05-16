import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve } from 'node:path';

// outputs a single-file html into app/src/main/assets/ika-js/index.html so the android
// webview can load it via file:///android_asset/ika-js/index.html. WASM blobs from
// @ika.xyz/sdk + @ika.xyz/pre-alpha-solana-client are inlined as data URIs (warning-suppressed
// since the webview has a real document context, unlike the extension's MV3 service worker).

export default defineConfig({
  root: resolve(__dirname),
  publicDir: false,
  build: {
    outDir: resolve(__dirname, '../app/src/main/assets/ika-js'),
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
      onwarn(warning, defaultHandler) {
        // suppress the multi-MB import.meta.url warning that fires when WASM blobs are inlined.
        // mirrors the wallet-extension vite config note in CLAUDE.md.
        if (warning.code === 'INVALID_ANNOTATION') return;
        if (warning.message?.includes('import.meta')) return;
        defaultHandler(warning);
      },
    },
  },
  plugins: [viteSingleFile()],
  resolve: {
    dedupe: ['@mysten/sui'],
  },
});
