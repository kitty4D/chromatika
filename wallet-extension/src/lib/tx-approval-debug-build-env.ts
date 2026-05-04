/**
 * read-only snapshot of Vite-baked `import.meta.env` for the tx approval popup.
 * lets you confirm `.env` values made it into this bundle (popup + worker are separate builds).
 */

import { ikaTxBenchAutoDownload, ikaTxBenchEnabled } from '@/lib/ika-tx-bench-env';

export type TxApprovalDebugBuildEnvRow = {
  key: string;
  /** stringified import.meta.env value; empty string if set but blank */
  raw: string | null;
};

/** mirrors `sui-graphql-debug-fetch` without importing background modules into the popup. */
export function suiGraphqlConsoleDebugEffective(): boolean {
  return Boolean(import.meta.env.DEV || import.meta.env.VITE_DEBUG_GRAPHQL === 'true');
}

export function suiGraphqlPaginationCaptureEffective(): boolean {
  return Boolean(
    import.meta.env.DEV ||
      import.meta.env.VITE_DEBUG_GRAPHQL === 'true' ||
      import.meta.env.VITE_DEBUG_GRAPHQL_PAGINATION === 'true',
  );
}

function rawEnv(key: keyof ImportMetaEnv): string | null {
  const v = import.meta.env[key];
  if (v === undefined || v === null) return null;
  return String(v);
}

export function getTxApprovalDebugBuildEnvRows(): {
  buildStamp: string;
  mode: string;
  dev: boolean;
  rows: TxApprovalDebugBuildEnvRow[];
  effective: {
    ikaTxBench: boolean;
    ikaTxBenchAutoDownload: boolean;
    suiGraphqlConsoleDebug: boolean;
    suiGraphqlPaginationCapture: boolean;
  };
} {
  return {
    buildStamp: typeof __CHROMATIKA_BUILD_STAMP__ === 'string' ? __CHROMATIKA_BUILD_STAMP__ : '(unknown)',
    mode: import.meta.env.MODE,
    dev: import.meta.env.DEV,
    rows: [
      { key: 'VITE_IKA_TX_BENCH', raw: rawEnv('VITE_IKA_TX_BENCH') },
      { key: 'VITE_IKA_TX_BENCH_AUTO_DOWNLOAD', raw: rawEnv('VITE_IKA_TX_BENCH_AUTO_DOWNLOAD') },
      { key: 'VITE_DEBUG_GRAPHQL', raw: rawEnv('VITE_DEBUG_GRAPHQL') },
      { key: 'VITE_DEBUG_GRAPHQL_PAGINATION', raw: rawEnv('VITE_DEBUG_GRAPHQL_PAGINATION') },
    ],
    effective: {
      ikaTxBench: ikaTxBenchEnabled(),
      ikaTxBenchAutoDownload: ikaTxBenchAutoDownload(),
      suiGraphqlConsoleDebug: suiGraphqlConsoleDebugEffective(),
      suiGraphqlPaginationCapture: suiGraphqlPaginationCaptureEffective(),
    },
  };
}
