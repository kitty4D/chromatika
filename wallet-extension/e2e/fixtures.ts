import { test as base, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

export type SwFetchMockResponse = {
  status: number;
  /** JSON-serializable response body. stringified before being returned as a Response. */
  body: unknown;
  headers?: Record<string, string>;
};

/**
 * install / extend a `globalThis.fetch` patch in the MV3 service worker that intercepts URLs
 * containing one of the registered `pattern` substrings and returns the canned response. real
 * fetches (anything not matching) pass through to the original.
 *
 * **why the SW context, not page.route**: chromatika's scan probes (DeSo, Cosmos, Polkadot,
 * EVM, BTC, Aptos) run in the background service worker. `page.route` only intercepts the
 * page-context fetch; SW fetch needs `worker.evaluate` patching. one-shot install pattern -
 * subsequent calls add more mocks to the same map without re-patching `fetch`.
 *
 * idempotent: safe to call multiple times. clear with `clearSwFetchMocks(worker)`.
 */
export async function mockSwFetch(
  worker: Worker,
  pattern: string,
  response: SwFetchMockResponse,
): Promise<void> {
  await worker.evaluate(({ pattern, response }) => {
    type Mock = { status: number; body: unknown; headers?: Record<string, string> };
    const g = globalThis as unknown as {
      __chromatika_e2e_fetchMocks?: Map<string, Mock>;
      __chromatika_e2e_fetchPatched?: boolean;
      __chromatika_e2e_origFetch?: typeof fetch;
    };
    const mocks = (g.__chromatika_e2e_fetchMocks ??= new Map<string, Mock>());
    mocks.set(pattern, response);
    if (!g.__chromatika_e2e_fetchPatched) {
      g.__chromatika_e2e_origFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        let url: string;
        if (typeof input === 'string') url = input;
        else if (input instanceof URL) url = input.toString();
        else url = input.url;
        for (const [pat, resp] of mocks.entries()) {
          if (url.includes(pat)) {
            return new Response(JSON.stringify(resp.body), {
              status: resp.status,
              headers: { 'content-type': 'application/json', ...(resp.headers ?? {}) },
            });
          }
        }
        return g.__chromatika_e2e_origFetch!(input, init);
      };
      g.__chromatika_e2e_fetchPatched = true;
    }
  }, { pattern, response });
}

/** remove all SW fetch mocks + restore the original fetch. */
export async function clearSwFetchMocks(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    const g = globalThis as unknown as {
      __chromatika_e2e_fetchMocks?: Map<string, unknown>;
      __chromatika_e2e_fetchPatched?: boolean;
      __chromatika_e2e_origFetch?: typeof fetch;
    };
    if (g.__chromatika_e2e_origFetch) {
      globalThis.fetch = g.__chromatika_e2e_origFetch;
    }
    g.__chromatika_e2e_fetchMocks?.clear();
    g.__chromatika_e2e_fetchPatched = false;
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pathToExtension = path.resolve(__dirname, '../dist');

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  backgroundWorker: Worker;
}>({
  context: async ({}, use) => {
    if (!existsSync(path.join(pathToExtension, 'manifest.json'))) {
      throw new Error(
        `Extension dist missing at ${pathToExtension}. Run "pnpm run build" before e2e tests.`,
      );
    }
    // isolated profile so a prior run's vault never hides the create path
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'chromatika-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
      ],
    });
    // cold MV3 SW: first extension page can hang on tRPC until the worker is executing
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 60_000 });
    }
    await sw.evaluate(() => true);
    await use(context);
    await context.close();
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* windows may hold locks briefly */
    }
  },

  backgroundWorker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) {
      worker = await context.waitForEvent('serviceworker');
    }
    await use(worker);
  },

  extensionId: async ({ backgroundWorker }, use) => {
    const url = backgroundWorker.url();
    const extensionId = url.split('/')[2];
    if (!extensionId) {
      throw new Error(`Could not parse extension id from service worker url: ${url}`);
    }
    await use(extensionId);
  },
});

export { expect };
