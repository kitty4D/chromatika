/**
 * singleton lazy-init wrapper around `@walletconnect/sign-client`.
 *
 * **why a singleton:** WC's `SignClient.init()` opens an IndexedDB-backed core (key + session
 * stores). the pairing component (`WalletConnectConnect`) and the signer popup
 * (`WalletConnectSigner`) both need to call `signClient.connect()` / `signClient.request()`,
 * and they share the same per-origin IndexedDB. two parallel `init()` calls race on the
 * underlying stores and can drop pending session approvals on the floor. a memoized
 * Promise-getter avoids that, first caller initializes, every subsequent caller awaits the
 * same Promise.
 *
 * **why lazy-imported:** `@walletconnect/sign-client` pulls in core libraries (relay client,
 * crypto, jsonrpc-utils), about 250 KB minified. most users never touch the WC option, so
 * we keep the eager bundle small by hiding the import behind the function call. the dynamic
 * `import()` only resolves when a user clicks the WC button (or the signer popup opens).
 *
 * **service worker NOT supported:** the WC core uses `localStorage` and `window.btoa/atob`,
 * neither of which exist in the MV3 SW. call this from popup / side-panel contexts only.
 */

import { buildWcAppMetadata, WC_PROJECT_ID, WC_RELAY_URL } from '@/config/wc';

// `SignClient` is the type the v2 sign-client default export resolves to. we keep the import
// type-only at module load (so the chunk is tiny) and pull the runtime class lazily.
type SignClient = Awaited<ReturnType<typeof import('@walletconnect/sign-client').SignClient.init>>;

let clientPromise: Promise<SignClient> | null = null;

/**
 * returns the (memoized) SignClient. throws if `WC_PROJECT_ID` is empty, UI gates the WC
 * button on `isWcEnabled()` so this should only happen if a popup is opened with stale state.
 */
export async function getWcSignClient(): Promise<SignClient> {
  if (!WC_PROJECT_ID) {
    throw new Error(
      'WalletConnect is disabled in this build (VITE_WC_PROJECT_ID is empty). Register a free project at cloud.reown.com and rebuild.',
    );
  }
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const { SignClient } = await import('@walletconnect/sign-client');
    return SignClient.init({
      projectId: WC_PROJECT_ID,
      relayUrl: WC_RELAY_URL,
      // resolve the metadata at init time so `metadata.url` matches the page origin
      // (chrome-extension://...) and the SDK doesn't warn about a mismatch.
      metadata: buildWcAppMetadata(),
    });
  })();
  return clientPromise;
}

/**
 * reset the memoized client. used after `signClient.disconnect()` to force a fresh init on
 * the next call - rare; mostly useful in tests / dev tools when the relay session has been
 * fully torn down and we want the IndexedDB stores re-opened cleanly.
 */
export function resetWcSignClient(): void {
  clientPromise = null;
}
