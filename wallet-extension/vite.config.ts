import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import webExtension from 'vite-plugin-web-extension';

const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url));
const buildStamp = new Date().toISOString();

/** files under public/ are not in the rollup graph, so plain `vite build --watch` skips them unless we watch explicitly */
function collectFilesRecursive(absDir: string): string[] {
  if (!fs.existsSync(absDir)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(absDir);
  return out;
}

// vite-plugin-web-extension runs child vite builds for each entrypoint.
// the parent rollup only re-triggers those child builds when an addWatchFile'd path changes.
// rollup's addWatchFile does NOT expand globs, so we enumerate real files for src/ + public/.
/**
 * MV3 service worker has no `document` or node `process`. bundled streams / deps use
 * `process.version` / `process.nextTick` in patterns that still touch `process` when
 * undefined -> ReferenceError and Chrome status 15. prepend minimal shims before the bundle.
 *
 * UI entry chunks hit the same `process is not defined` issue: the `buffer-polyfill`
 * side-effect import lands inside a shared chunk (ErrorBoundary.js) tens of KB past
 * code that already touches `process.browser` / `process.nextTick` at module init.
 * ESM post-order evaluation means leaf chunks run first, so anything short of an
 * inline banner on every chunk is too late. prepend the shim to every .js chunk;
 * the `typeof` guard makes re-runs no-ops.
 */
function chromatikaSwBootstrap(): Plugin {
  /** long __CHSW* names so the bg minifier does not collide with rollup's outer iife params. */
  const banner =
    '(function(){try{var __CHSWDOC=globalThis;if(__CHSWDOC.document==null){var __CHSWBASE=typeof chrome!=="undefined"&&chrome.runtime&&chrome.runtime.getURL?chrome.runtime.getURL(""):"";__CHSWDOC.document={currentScript:null,baseURI:__CHSWBASE,documentElement:null}}}catch(_e){}var __CHSWP=globalThis;if(typeof __CHSWP.process==="undefined"){__CHSWP.process={env:{NODE_ENV:"production"},browser:!0,version:"v18.0.0",versions:{},platform:"browser",nextTick:function(cb){setTimeout(cb,0)},stdout:{write:function(){}},stderr:{write:function(){}}}}})();';

  return {
    name: 'chromatika-sw-bootstrap',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        const c = bundle[fileName];
        if (!c || c.type !== 'chunk') continue;
        if (!fileName.endsWith('.js')) continue;
        c.code = banner + c.code;
      }
    },
  };
}

function chromatikaWatchAll(): Plugin {
  return {
    name: 'chromatika-watch-all',
    buildStart() {
      const manifestAbs = resolve(REPO_ROOT, 'src', 'manifest.json');
      for (const dir of ['src', 'public']) {
        for (const f of collectFilesRecursive(resolve(REPO_ROOT, dir))) {
          if (f === manifestAbs) continue; // web-extension plugin watches this itself
          this.addWatchFile(f);
        }
      }
      for (const rel of ['vite.config.ts', 'index.html', 'side_panel.html', 'onboarding.html']) {
        const p = resolve(REPO_ROOT, rel);
        if (fs.existsSync(p)) this.addWatchFile(p);
      }
    },
  };
}

/**
 * chrome MV3 reserves top-level `_metadata` / `_locales`, so ANY `_*.js` at the
 * dist root (think `@noble/curves/_shortw_utils.js` or rollup's
 * `__vite-browser-external` stub) makes `load unpacked` rage-quit with
 * "Filenames starting with _ are reserved for use by the system." rude.
 *
 * vite-plugin-web-extension hardcodes `chunkFileNames: '[name].js'` and merges
 * AFTER our user config, so output filename overrides are silently ignored.
 * BUT the plugin doesn't set manualChunks - so we redirect offending modules
 * into chunks with clean names. rollup feeds the returned name into `[name].js`
 * and the chunk lands at e.g. `noble-shortw-utils.js`. no leading `_`, no rage.
 *
 * covers two known sources today:
 *   - @noble/{curves,hashes} ship internal helpers prefixed `_` (e.g.
 *     _shortw_utils, _md, _assert, _u64) - shared across many entries so
 *     rollup hoists them into chunks named after the source basename.
 *   - rollup/vite synthetic stub for node builtins externalized for browser
 *     (crypto/stream pulled by @lazorkit/wallet, @solana/kora, cipher-base) -
 *     would otherwise emit `__vite-browser-external.js`.
 *
 * the plugin spawns 4 child vite builds: a multi-HTML parent (code-splits, can
 * have shared chunks - this is where `_*.js` files leak) plus 3 individual
 * lib/IIFE builds for the SW + content-script + dapp-interface (no splitting,
 * everything inlined into one IIFE per entry). rolldown REJECTS manualChunks
 * when codeSplitting is off, so we only attach it for non-lib builds.
 */
function chromatikaUnderscoreSafeChunks(): Plugin {
  return {
    name: 'chromatika-underscore-safe-chunks',
    config(config) {
      if (config.build?.lib) return;
      return {
        build: {
          rollupOptions: {
            output: {
              manualChunks(id: string) {
                // any node_modules file whose basename starts with `_` is an
                // internal helper that rollup may hoist into a `_*.js` chunk
                // at dist root. covers @noble/curves (ESM or src - shortw_utils
                // lives under both `esm/` and `src/`) and @noble/hashes (_md,
                // _u64, _assert, _blake, etc). also handles future deps.
                if (id.includes('node_modules')) {
                  const m = id.match(/[\\/](_[A-Za-z0-9_-]+)\.(?:ts|c?m?js)$/);
                  if (m) {
                    const safe = m[1].replace(/^_+/, '').replace(/[^A-Za-z0-9]/g, '-');
                    if (id.includes('@noble')) return `noble-${safe}`;
                    return `vendor-${safe}`;
                  }
                }
                // vite's browser-external stub - id looks like `browser-external:crypto`
                // or contains `__vite-browser-external` depending on resolution stage
                if (id.includes('browser-external')) return 'vendor-browser-external';
              },
            },
          },
        },
      };
    },
  };
}

export default defineConfig({
  plugins: [
    chromatikaWatchAll(),
    chromatikaUnderscoreSafeChunks(),
    chromatikaSwBootstrap(),
    react(),
    webExtension({
      manifest: './src/manifest.json',
      // chromatikaWatchAll handles all file watching - no watchFilePaths needed here
      additionalInputs: ['src/dapp-interface/inject.ts', 'onboarding.html'],
      // `vite build --watch`: without this, web-ext spawns a fresh Chromium on every rebuild
      // (watchChange exits the runner; closeBundle opens again). load unpacked from dist/ once
      // and use chrome://extensions -> Reload (see README "Manual testing in Chrome").
      disableAutoLaunch: process.env.CHROMATIKA_WEBEXT_LAUNCH !== '1',
    }),
  ],
  resolve: {
    alias: {
      '@ika-pre-alpha/dwallet-grpc-web-client': resolve(
        REPO_ROOT,
        'node_modules/@ika.xyz/pre-alpha-solana-client/src/generated/grpc-web/ika_dwallet.client.ts',
      ),
      '@': resolve(REPO_ROOT, 'src'),
      // rolldown commonjs resolver misses @scure/bip39 package "exports" for this subpath (tsc/node ok)
      '@scure/bip39/wordlists/english.js': resolve(
        REPO_ROOT,
        'node_modules/@scure/bip39/wordlists/english.js',
      ),
      // @human.tech/waap-sdk declares react as an OPTIONAL peer dep. vite's optional-peer-dep
      // stub returns undefined for missing peers, which breaks waap-sdk's `useWaapTransaction`
      // hook (uses `useState` directly at module scope). force-resolve react to our actual copy
      // so the stub doesn't get in the way; we have react as a direct dep regardless.
      react: resolve(REPO_ROOT, 'node_modules/react'),
      'react-dom': resolve(REPO_ROOT, 'node_modules/react-dom'),
    },
    // single mysten + ika copies - duplicate IkaClient class breaks TS private helpers (`... .call` on undefined)
    dedupe: ['@mysten/sui', '@ika.xyz/sdk', 'react', 'react-dom'],
  },
  define: {
    // some node-oriented deps (ledger, bitcoinjs, etc.) reference `global` - map to browser equivalent
    global: 'globalThis',
    __CHROMATIKA_BUILD_STAMP__: JSON.stringify(buildStamp),
    __CHROMATIKA_PREVIEW_IFRAME__: JSON.stringify(false),
  },
  build: {
    sourcemap: true,
    // keep dist/ in place so chrome doesn't "reinstall" the unpacked extension and wipe chrome.storage
    emptyOutDir: false,
    // watch: chokidar reads CHOKIDAR_USEPOLLING from the env - use `pnpm run dev:polling` on windows if saves do not rebuild
    // raised from default 500 kB: chromatika's eager UI shell (`index.js`) is ~850 kB and not
    // unreasonable for a feature-rich wallet extension; 1000 kB leaves headroom while still
    // catching genuine bloat regressions.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      // rolldown rc.12 (the bundler under vite 8) warns whenever a non-ESM output target
      // contains `import.meta` and prints the ENTIRE offending file as warning context.
      // for chromatika this fires on a deep dep that bundles a multi-MB WASM blob, so the
      // warning balloons to ~60 MB of stdout per dev rebuild and freezes the terminal.
      // the replacement (`import.meta` -> `{}`) is correct for the deps in question (they
      // all have non-ESM fallbacks); we just don't want the firehose. suppress.
      onwarn(warning, defaultHandler) {
        const message = warning?.message ?? '';
        if (message.includes('import.meta') && message.includes('replaced with an empty object')) {
          return;
        }
        defaultHandler(warning);
      },
    },
  },
});
