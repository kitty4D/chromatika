/**
 * one-time `initWaaPSui` per ui mount. waap-sdk uses `window` + dom + postmessage; safe in
 * side-panel + popup contexts, NOT in the mv3 service worker. import lazily to keep the bundle
 * cost off the main wallet shell when nobody touches the waap path.
 */

import type { WaaPSuiWalletInterface, AuthenticationMethod } from '@human.tech/waap-sdk';

/** waap doesn't ship a discriminator excluding `'wallet'` for sui — we narrow ourselves. */
type SuiAuthenticationMethod = Exclude<AuthenticationMethod, 'wallet'>;

let cached: WaaPSuiWalletInterface | null = null;
let initInFlight: Promise<WaaPSuiWalletInterface> | null = null;

export type WaapInitOpts = {
  /** override allowed login methods. default: ['email', 'phone', 'social']. */
  authenticationMethods?: SuiAuthenticationMethod[];
  /** default: ['google', 'discord', 'twitter', 'github', 'bluesky']. */
  allowedSocials?: ReadonlyArray<'google' | 'discord' | 'twitter' | 'github' | 'bluesky'>;
  /** match the active chromatika theme. default: true (chromatika ships dark). */
  darkMode?: boolean;
  /** project id for waap analytics / feature gating. optional. */
  projectId?: string;
};

/**
 * lazily load `@human.tech/waap-sdk` and call `initWaaPSui` exactly once. subsequent calls
 * return the cached `WaaPSuiWalletInterface`. throws on sw context (no `window`).
 */
export async function ensureWaapSuiWallet(opts: WaapInitOpts = {}): Promise<WaaPSuiWalletInterface> {
  if (cached) return cached;
  if (initInFlight) return initInFlight;
  if (typeof window === 'undefined') {
    throw new Error('waap-sdk cannot run in the service worker (no `window`); init must happen in side-panel / popup context.');
  }

  initInFlight = (async () => {
    // dynamic import keeps the ~1mb sdk out of bundles that never touch waap.
    const { initWaaPSui } = await import('@human.tech/waap-sdk');
    const wallet = initWaaPSui({
      project: {
        name: 'Chromatika',
        // logo + entryTitle keep waap's modal branded; readme suggests they're optional.
      },
      config: {
        authenticationMethods: opts.authenticationMethods ?? (['email', 'phone', 'social'] as SuiAuthenticationMethod[]),
        // styles flag is what the project's plan documented; waap-sdk's actual config supports darkMode.
        styles: { darkMode: opts.darkMode ?? true },
      },
    });
    cached = wallet;
    initInFlight = null;
    return wallet;
  })();
  return initInFlight;
}

/** clear cached wallet (e.g., on lock so a fresh login re-runs the modal next time). */
export function disposeWaapSuiWallet(): void {
  cached = null;
  initInFlight = null;
}
