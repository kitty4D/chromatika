/**
 * remote MWA (desktop ↔ phone over wss reflector) - types + helpers shared
 * between the UI pairing component, the signer popup, and the wallet-service
 * vault record.
 *
 * `startRemoteScenario` from `@solana-mobile/mobile-wallet-adapter-protocol-web3js`
 * runs in the UI (side panel / popup) - NOT the service worker. the browser
 * bundle calls `window.btoa` / `window.atob` which MV3 SWs do not expose.
 * keeping handshake there means we don't need a `globalThis.window` polyfill
 * and we don't fight SW eviction killing a long-lived ws.
 *
 * this module deliberately does NOT call `startRemoteScenario` itself - UI
 * code does. the module exists to:
 *  - pin the reflector host authority in one place (auditable),
 *  - shape the persisted `auth_token` row so background and UI agree,
 *  - provide small type guards / discriminants for transport dispatch.
 *
 * reference: `wallet-extension/docs/future/SEEKER_REMOTE_MWA.md`.
 */

import type { RemoteWalletAssociationConfig } from '@solana-mobile/mobile-wallet-adapter-protocol';

/**
 * host authority (no scheme, no path) for the MWA reflector. `startRemoteScenario`
 * constructs `wss://${remoteHostAuthority}/reflect` internally - must NOT include
 * `wss://` or `/reflect` here.
 *
 * **canonical**: Solana Mobile operates a public reflector at
 * `development.reflector.solanamobile.com`. all shipping MWA wallets (Phantom,
 * Solflare, Jupiter, Seeker bundled) are tested against this host - using it
 * means the wallets actually pair. (self-hosted reflectors trip wallet allowlists
 * or untested code paths and silently freeze the wallet UI; that's why the
 * earlier `chromatika-mwa-reflector.<your>.workers.dev` swap didn't work.)
 *
 * **fallback**: a Cloudflare-Workers reflector lives in [`/reflector`](/reflector)
 * for self-hosting, in case Solana Mobile's host goes down or we want to fully
 * own the relay surface. swap this constant to that hostname if needed; expect
 * to hit wallet-side compatibility issues until each wallet ships an allowlist
 * update.
 *
 * if the reflector ever moves we ship a versioned constant and migrate the
 * persisted `mwaReflectorHost` rows. currently no migration is required because
 * pre-release dev profiles can be cleared (per CLAUDE.md "pre-release: no
 * obligation to migrate older dev profiles").
 */
export const MWA_REMOTE_HOST_AUTHORITY = 'development.reflector.solanamobile.com';

/** logical transport discriminant on `vendor:'mwa'` hardware records. */
export type MwaTransport = 'local' | 'remote';

/**
 * persisted remote-MWA state, stored on the encrypted hardware vault record so
 * we can re-authorize without rescanning the QR. `authToken` is opaque to us -
 * the wallet on the phone owns its meaning. we pass it back through
 * `wallet.authorize({ auth_token, identity })` on each sign attempt.
 *
 * if the wallet has revoked the token (user removed Chromatika from their
 * trusted apps list, etc.) the authorize call rejects with
 * `ERROR_AUTHORIZATION_FAILED` and the UI re-prompts a QR pairing.
 */
export type MwaRemotePersisted = {
  transport: 'remote';
  authToken: string;
  /** base58 Solana address the wallet authorized. */
  address: string;
  /** host authority in use at pairing time. pinned so a reflector swap doesn't silently break stored tokens. */
  reflectorHost: string;
  pairedAtEpochMs: number;
};

/** type guard for the persisted remote shape. */
export function isMwaRemotePersisted(x: unknown): x is MwaRemotePersisted {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    r['transport'] === 'remote' &&
    typeof r['authToken'] === 'string' &&
    typeof r['address'] === 'string' &&
    typeof r['reflectorHost'] === 'string' &&
    typeof r['pairedAtEpochMs'] === 'number'
  );
}

/**
 * build the config object expected by
 * `startRemoteScenario(config: RemoteWalletAssociationConfig)`. UI code calls
 * the library; this just centralizes the host-authority and any future option
 * defaults so we don't drift.
 */
export function buildRemoteMwaConfig(overrides?: { hostAuthority?: string; baseUri?: string }): RemoteWalletAssociationConfig {
  return {
    remoteHostAuthority: overrides?.hostAuthority ?? MWA_REMOTE_HOST_AUTHORITY,
    ...(overrides?.baseUri ? { baseUri: overrides.baseUri } : {}),
  };
}
