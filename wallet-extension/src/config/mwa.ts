/**
 * Solana mobile wallet adapter (MWA) configuration constants.
 *
 * MWA_REFLECTOR_URL: wss relay server that bridges the extension popup
 * and the mobile wallet app (Phantom Mobile, Solflare, etc.).
 * confirm this URL against https://docs.solanamobile.com/android-native/mwa_deep_dive
 * before shipping to production: the reflector host can change between SDK releases.
 *
 * MWA_CHAIN_ID: chain identifier sent in the `authorize` RPC call.
 * use 'solana:devnet' for devnet-only pre-alpha flows.
 */
export const MWA_REFLECTOR_URL = 'wss://reflect.solanamobile.com';

/** Solana chain id sent during MWA authorize handshake. */
export const MWA_CHAIN_ID = 'solana:mainnet';

/** app identity shown on the mobile wallet approval screen. */
export const MWA_APP_IDENTITY = {
  name: 'Chromatika',
  uri: 'https://chromatika.xyz',
  icon: '/icon.png',
} as const;
