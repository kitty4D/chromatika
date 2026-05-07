/**
 * Minimal `globalThis.chrome` stub for the static preview bundle.
 *
 * Real chromatika components reach into `chrome.storage.onChanged.addListener`,
 * `chrome.runtime.sendMessage`, etc. - none of which exist outside an extension. This
 * stub returns a recursive Proxy: any property access returns another no-op Proxy, any
 * call returns a Promise that resolves to `undefined`. Components that defensive-code
 * around missing keys fall through their fallback paths; components that crash on a
 * missing method log a console warning we can act on.
 *
 * Imported for side effect at the top of every preview entry. Idempotent.
 */

import { previewChromeStorageNamespace } from './preview-local-storage';

declare global {
  interface Window {
    chrome?: unknown;
  }
}

function makeNoopFn(path: string) {
  // chrome.runtime.getURL is special: production wallet code uses it for static asset
  // paths (`chrome.runtime.getURL('logos/btc.svg')` etc) and feeds the result into
  // <img src=...>. real chrome returns a string synchronously, so we mirror that here -
  // returning a Promise would stringify to "[object Promise]" and break the asset.
  // we resolve against `document.baseURI` so the preview's `<base>` (set via vite's
  // base config) is honored: '/wallet-live/' -> '/wallet-live/logos/btc.svg', etc.
  if (path === 'chrome.runtime.getURL') {
    return (rel?: unknown) => {
      const r = typeof rel === 'string' ? rel : '';
      try {
        return new URL(r, document.baseURI).href;
      } catch {
        return r;
      }
    };
  }
  // returns a function that, when called, also resolves any callback arg with undefined
  // and returns a Promise<undefined>. Most chrome APIs are dual-shape (callback OR
  // promise) so we cover both.
  const fn = (...args: unknown[]) => {
    for (const a of args) {
      if (typeof a === 'function') {
        try {
          (a as (v?: unknown) => void)(undefined);
        } catch {
          /* swallow - preview is non-interactive, errors here are noise */
        }
      }
    }
    return Promise.resolve(undefined);
  };
  // attach a debug tag so console-spelunking can trace where a component touched chrome
  Object.defineProperty(fn, '__chromaPreviewPath', { value: path, enumerable: false });
  return fn;
}

function makeStub(path: string): unknown {
  const cache = new Map<string, unknown>();
  const target = makeNoopFn(path);
  return new Proxy(target, {
    get(_t, prop, _r) {
      if (typeof prop !== 'string') return undefined;
      // identity / housekeeping props - return literals so spread/Object.keys don't blow up
      if (prop === Symbol.toPrimitive as unknown as string) return undefined;
      if (prop === 'toString') return () => `[chromatika-preview chrome-stub: ${path}]`;
      const cached = cache.get(prop);
      if (cached !== undefined) return cached;
      const child = makeStub(path === '' ? prop : `${path}.${prop}`);
      cache.set(prop, child);
      return child;
    },
    apply(_t, _self, args) {
      return makeNoopFn(path)(...(args as unknown[]));
    },
  });
}

// Real Chrome browsers expose a partial `chrome` global on every page (chrome.app,
// chrome.runtime sometimes) without `chrome.storage` etc. Always install our stub so
// extension-only paths (chrome.storage.onChanged, chrome.runtime.sendMessage) get
// no-op proxies instead of throwing on missing namespaces.
const existing = (globalThis as { chrome?: Record<string, unknown> }).chrome;
const stub = makeStub('chrome') as Record<string, unknown>;
const previewStorageNs = previewChromeStorageNamespace();

function previewChromeTrap(target: object, prop: string | symbol) {
  if (prop === 'storage') return previewStorageNs;
  const own = Reflect.get(target, prop);
  if (own !== undefined) return own;
  return Reflect.get(stub, prop);
}

if (existing && typeof existing === 'object') {
  // Wrap so any real fields the browser exposed stay accessible, but missing fields
  // fall through to the proxy. `storage` is always our preview shim so ika base mode +
  // `useIkaBaseMode` storage listeners behave like prod.
  (globalThis as { chrome?: unknown }).chrome = new Proxy(existing, { get: previewChromeTrap });
} else {
  (globalThis as { chrome?: unknown }).chrome = new Proxy({} as object, { get: previewChromeTrap });
}

export {};
