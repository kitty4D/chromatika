/**
 * WalletConnect v2 configuration constants. sibling of `@/config/mwa` - we keep one
 * auditable file per transport so a reviewer can find the relay host, project id,
 * and chain ids without grepping six files.
 *
 * `VITE_WC_PROJECT_ID` is required for the WalletConnect option to be enabled in the
 * hardware step. without it the button stays disabled and explains how to register a
 * free project at cloud.reown.com (Reown is the post-rebrand WalletConnect Inc.).
 *
 * **CAIP-2 chain ids are genesis-hash based**, not friendly names. Solana wallets
 * disagree on which one they advertise: most pin mainnet, a few advertise both
 * mainnet + devnet, Phantom Mobile / Solflare cover both. we pin mainnet for now and
 * fall back to devnet if the wallet rejects mainnet during pairing - chromatika is
 * pre-alpha for ika Solana so devnet is the realistic surface area, but the user's
 * Solana wallet binds to *their* Solana mainnet key regardless.
 */

export const WC_RELAY_URL = 'wss://relay.walletconnect.com';

/**
 * build-time project id. empty string when not set; `isWcEnabled()` keys off length so
 * the UI can hide / disable the WalletConnect button cleanly.
 */
export const WC_PROJECT_ID: string = (import.meta.env.VITE_WC_PROJECT_ID as string | undefined) ?? '';

/**
 * app identity surfaced on the wallet's connect prompt. the `url` is resolved at init time
 * inside the UI context (popup / side panel / onboarding tab) via `chrome.runtime.getURL('')`,
 * which produces the actual page origin (e.g. `chrome-extension://<extension-id>/`).
 *
 * **why dynamic:** the WC SDK warns when `metadata.url` does not match the page's actual URL
 * at `SignClient.init()` time. a hardcoded marketing URL like `https://chromatika.xyz` always
 * mismatches inside an extension context, polluting the console and disabling identity
 * attestation badges some mobile wallets surface. resolving to the extension URL avoids both.
 *
 * `icons[0]` stays on a public CDN URL so wallets can fetch the favicon - mobile wallets do
 * not load `chrome-extension://` resources.
 *
 * the static metadata (`name`, `description`, `icons`) is exported as `WC_APP_METADATA_STATIC`
 * for places that don't need to construct the live URL (e.g. type tests). the full metadata
 * is built by `buildWcAppMetadata()` at the call site.
 */
export const WC_APP_METADATA_STATIC = {
  name: 'Chromatika',
  description: 'Chromatika multi-chain wallet',
  icons: ['https://chromatika.xyz/icon.png'],
} as const;

export function buildWcAppMetadata(): {
  name: string;
  description: string;
  url: string;
  icons: string[];
} {
  // `chrome.runtime.getURL('')` works in popup / side panel / onboarding tab (any UI context
  // backed by the extension's manifest). it returns `chrome-extension://<id>/` which matches
  // `window.location.origin` for those pages. fallback to a marketing URL only if the runtime
  // API is unavailable (shouldn't happen in shipping builds; tests / SSR paths might hit it).
  let url = 'https://chromatika.xyz';
  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.getURL) {
      const ext = chrome.runtime.getURL('');
      if (ext) url = ext;
    }
  } catch {
    // ignore - fallback URL applies
  }
  return { ...WC_APP_METADATA_STATIC, icons: [...WC_APP_METADATA_STATIC.icons], url };
}

/**
 * CAIP-2 chain ids. Solana namespace uses the first 32 chars of the genesis block hash.
 * source: https://docs.walletconnect.com/2.0/web3wallet/wallet-usage#solana
 */
export const WC_SOLANA_CHAIN_ID_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const WC_SOLANA_CHAIN_ID_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/** methods we want the wallet to authorize during the WC `connect()` call. */
export const WC_SOLANA_METHODS = ['solana_signMessage', 'solana_signTransaction'] as const;

export type WcSolanaMethod = (typeof WC_SOLANA_METHODS)[number];

export function isWcEnabled(): boolean {
  return WC_PROJECT_ID.length > 0;
}

/**
 * map an active-network registry id (e.g. `'sol-mainnet'`, `'sol-devnet'`) to the
 * matching WC v2 CAIP-2 chain id. used at sign time so each `solana_signTransaction`
 * request carries the chainId of the cluster the tx actually targets, even though
 * the WC session was paired against mainnet (Jupiter / Phantom / Solflare bind
 * their authorized account to mainnet regardless of which clusters are advertised).
 *
 * without this, signing a devnet-blockhash tx through a mainnet-paired session
 * makes the wallet's pre-sign sanity check fail ("blockhash not found on this
 * cluster") and surface a user-confusing "there's a problem with the transaction"
 * rejection: which is exactly the foot-gun the prior pair-time-frozen `chainId`
 * field caused.
 *
 * unknown / null inputs default to mainnet because:
 *   1. mainnet is the cluster Phantom-class wallets always bind their account to.
 *   2. off-chain `solana_signMessage` signs (no blockhash, no simulation) work on
 *      either cluster; defaulting to mainnet matches the most common case.
 */
export function wcSolanaChainIdForCluster(networkId: string | null | undefined): string {
  if (networkId === 'sol-devnet') return WC_SOLANA_CHAIN_ID_DEVNET;
  return WC_SOLANA_CHAIN_ID_MAINNET;
}

/**
 * friendly cluster label for the hardware sign popup (WC / MWA). maps registry
 * network ids to a short noun the user recognizes. defaults to `'mainnet'` for
 * unknown / null inputs to match `wcSolanaChainIdForCluster`'s default.
 */
export function solanaClusterLabelForNetworkId(networkId: string | null | undefined): string {
  if (networkId === 'sol-devnet') return 'devnet';
  if (networkId === 'sol-testnet') return 'testnet';
  if (networkId === 'sol-localnet') return 'localnet';
  return 'mainnet';
}
