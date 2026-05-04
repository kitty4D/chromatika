/**
 * WalletConnect v2 (Solana) types + helpers shared between the UI pairing component,
 * the signer popup, and the wallet-service vault record. Sibling of `mwa-remote.ts`.
 *
 * `SignClient.init()` lives in UI code (popup / side panel) - NOT in the service worker.
 * WC's relay client uses `localStorage` + IndexedDB which the SW does not expose, and
 * the relay websocket is long-lived in a way that a 30-second SW keepalive would kill.
 * Centralizing the type + guard here keeps a single source for both surfaces.
 *
 * **Why a sibling file instead of folding into mwa-remote:** the lifecycles diverge
 * (WC `signClient.disconnect(topic)` vs MWA `scenario.close()`), the error taxonomies
 * diverge (`getSdkError('USER_REJECTED')` / `'EXPIRED'` vs MWA's `ERROR_AUTHORIZATION_FAILED`),
 * and the persisted "session" shape diverges (WC sessionTopic + chainId vs MWA auth_token).
 * Forcing them into one helper would just push the divergence into call sites.
 */

import { WC_PROJECT_ID } from '@/config/wc';

/**
 * Persisted WalletConnect session row, stored on the encrypted hardware vault record so
 * we can re-use the existing relay session for subsequent signs. The `sessionTopic` is
 * what the relay uses to route requests to the connected wallet; if the wallet revokes
 * the session (user removes Chromatika from "connected dapps") the next `signClient.request`
 * rejects with "no matching session" / "session expired" and the popup falls into a
 * needs-repair state, analogous to MWA's revoked `auth_token`.
 *
 * `chainId` is frozen at pair time so we send subsequent requests on the same CAIP-2
 * namespace the wallet actually authorized; sending mainnet requests on a session the
 * wallet authorized for devnet (or vice versa) gets us a flat reject.
 */
export type WcSessionPersisted = {
  vendor: 'walletconnect';
  /** Opaque relay topic returned by `signClient.connect().approval()`. */
  sessionTopic: string;
  /** Base58 Solana pubkey the wallet authorized at pair time. */
  accountAddress: string;
  /** CAIP-2 chain id frozen at pair time, e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. */
  chainId: string;
  pairedAtEpochMs: number;
};

/** Type guard for the persisted shape. Used at unlock-time when widening from `unknown`. */
export function isWcSessionPersisted(x: unknown): x is WcSessionPersisted {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    r['vendor'] === 'walletconnect' &&
    typeof r['sessionTopic'] === 'string' &&
    typeof r['accountAddress'] === 'string' &&
    typeof r['chainId'] === 'string' &&
    typeof r['pairedAtEpochMs'] === 'number'
  );
}

/**
 * Whether the WalletConnect transport is available on this build. Keys off the project
 * id at module load. Re-export of the config helper so call sites that import vendor
 * helpers do not also need to know about `@/config/wc`.
 */
export function isWcEnabled(): boolean {
  return WC_PROJECT_ID.length > 0;
}
