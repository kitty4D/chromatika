/**
 * build-time flags. phase B = Sui swap/top-up path to IKA.
 * swap is on by default for beta; set `VITE_PHASE_B_SUI_SWAP=false` to disable.
 */
export const FEATURES = {
  PHASE_B_SUI_SWAP: import.meta.env.VITE_PHASE_B_SUI_SWAP !== 'false',
  /** dev servers or `VITE_SOLANA_IKA_BASE=true`: hide Solana ika base in production builds by default. */
  SOLANA_IKA_BASE_IN_UI: import.meta.env.DEV || import.meta.env.VITE_SOLANA_IKA_BASE === 'true',
} as const;
