/**
 * MV3 service workers have no DOM. vite still emits an import.meta.url helper that does
 * `new URL(relativePath, document.baseURI)` when bundling wasm / some deps: that throws
 * ReferenceError: document is not defined before any wasm fetch runs.
 *
 * give the worker a tiny fake document with a base URI at the extension root so URL resolution
 * at least has a string base (wasm may still be loaded via inlined data URLs elsewhere).
 */
export function installServiceWorkerDocumentShim(): void {
  const g = globalThis as typeof globalThis & { document?: unknown };
  if (g.document !== undefined) return;
  const baseURI = chrome.runtime.getURL('');
  // not a real Document: only fields vite / wasm glue read in the service worker
  g.document = {
    currentScript: null,
    baseURI,
    documentElement: null,
  } as unknown as Document;
}

installServiceWorkerDocumentShim();

// ------------------------------------------------------------------------
// MV3 SW WASM data-URL workaround
// ------------------------------------------------------------------------
//
// Chromium MV3 service workers can't construct a `URL` from the multi-MB
// `data:application/wasm;base64,...` blob that wasm-bindgen emits as the default
// fallback in `@ika.xyz/sdk`'s wasm loader (`dwallet_mpc_wasm.js`). the error
// surfaces as `Failed to construct 'URL': Invalid base URL` deep inside
// `UserShareEncryptionKeys.fromRootSeedKey` and breaks every `createVault`
// onboarding path. compounding it: `URL.createObjectURL` is *missing entirely*
// from the URL constructor in MV3 SW context (verified with a probe: the
// `createObjectURL` static method that MDN claims is available in service
// workers is genuinely absent here), so the obvious "convert to a blob URL"
// fix is impossible.
//
// fix: substitute the inline data URL with a synthetic `chrome-extension://`
// URL pointing at a stash key, and patch global `fetch` to serve the wasm
// bytes from that stash. both shims are dormant for any input other than
// `data:application/wasm;base64,...`, so non-wasm callers see zero behavior
// change.
//
// drop this whole block once chromium gives MV3 SWs `URL.createObjectURL`
// back, OR once `@ika.xyz/sdk` ships its WASM as a separate `.wasm` asset
// instead of an inline data URL.
{
  const g = globalThis as typeof globalThis & {
    URL: typeof URL;
    fetch: typeof fetch;
  };

  const Original = g.URL;
  const originalFetch = g.fetch;
  const WASM_DATA_URL_PREFIX = 'data:application/wasm;base64,';
  const STASH_PATH = '__chromatika_wasm_stash__';

  // bytes stored by stash key: survives across multiple URL constructions
  const stash = new Map<string, Uint8Array>();
  let stashCounter = 0;

  function decodeWasmDataUrl(dataUrl: string): Uint8Array {
    const b64 = dataUrl.slice(WASM_DATA_URL_PREFIX.length);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function syntheticUrlFor(id: string): string {
    // chrome-extension:// is a valid URL scheme so `new URL(...)` accepts it
    // even in MV3 SW context. fetch() against this URL will hit our patched
    // fetch below: never the real network or extension filesystem.
    return chrome.runtime.getURL(`${STASH_PATH}/${id}`);
  }

  function PatchedURL(this: URL, input: string | URL, base?: string | URL) {
    if (typeof input === 'string' && input.startsWith(WASM_DATA_URL_PREFIX)) {
      const id = `w${stashCounter++}`;
      try {
        stash.set(id, decodeWasmDataUrl(input));
        return new Original(syntheticUrlFor(id)) as unknown as URL;
      } catch {
        // base64 decode or constructor failed: fall through to native and let
        // the real error surface so we don't mask a different bug.
      }
    }
    return (base !== undefined ? new Original(input, base) : new Original(input)) as unknown as URL;
  }

  // copy URL static members so `URL.canParse` / `URL.parse` keep working.
  // NOTE: `URL.createObjectURL` doesn't exist in MV3 SW (confirmed by probe);
  // the loop will silently skip it, which is fine: nothing in chromatika
  // calls it through `URL.createObjectURL` directly.
  for (const k of ['canParse', 'parse', 'createObjectURL', 'revokeObjectURL'] as const) {
    if (k in Original) {
      const fn = (Original as unknown as Record<string, unknown>)[k];
      if (typeof fn === 'function') {
        (PatchedURL as unknown as Record<string, unknown>)[k] = (
          fn as (...args: unknown[]) => unknown
        ).bind(Original);
      }
    }
  }
  (PatchedURL as unknown as { prototype: URL }).prototype = Original.prototype;
  g.URL = PatchedURL as unknown as typeof URL;

  // patch fetch to recognize stash URLs and return the wasm bytes as a real
  // Response. wasm-bindgen typically calls `instantiateStreaming(fetch(url))`
  // so the Response's content-type matters: it must be `application/wasm`.
  g.fetch = async function chromatikaWasmStashFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let urlStr: string | null = null;
    if (typeof input === 'string') urlStr = input;
    else if (input instanceof Original) urlStr = (input as unknown as URL).href;
    else if (input instanceof Request) urlStr = input.url;

    if (urlStr && urlStr.includes(STASH_PATH)) {
      const id = urlStr.split('/').pop() ?? '';
      const bytes = stash.get(id);
      if (bytes) {
        // copy so the caller can't mutate our stash (and so the underlying
        // ArrayBuffer can be transferred / detached without affecting future
        // re-instantiations).
        const copy = new Uint8Array(bytes);
        return new Response(copy, {
          status: 200,
          headers: { 'content-type': 'application/wasm' },
        });
      }
    }
    return originalFetch.call(g, input, init);
  };
}
