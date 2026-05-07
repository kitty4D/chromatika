/// <reference types="vite/client" />

declare const __CHROMATIKA_BUILD_STAMP__: string;
declare const __CHROMATIKA_PREVIEW_IFRAME__: boolean;

interface ImportMetaEnv {
  readonly VITE_CMC_API_KEY?: string;
  readonly VITE_ALCHEMY_KEY?: string;
  readonly VITE_HELIUS_KEY?: string;
  readonly VITE_PHASE_B_SUI_SWAP?: string;
  readonly VITE_SOLANA_IKA_BASE?: string;
  readonly VITE_DEBUG_GRAPHQL?: string;
  /** comma-separated GraphQL operation names to log when `VITE_DEBUG_GRAPHQL` is on; unset = log all. add `_anon_` to include unnamed requests. */
  readonly VITE_DEBUG_GRAPHQL_OPS?: string;
  readonly VITE_DEBUG_GRAPHQL_PAGINATION?: string;
  /** `true` = record ika-related tx phases with `performance.now()` in the service worker. */
  readonly VITE_IKA_TX_BENCH?: string;
  /** with `VITE_IKA_TX_BENCH=true`, `true` = download one JSON file per completed flow immediately. */
  readonly VITE_IKA_TX_BENCH_AUTO_DOWNLOAD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
