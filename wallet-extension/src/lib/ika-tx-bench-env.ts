/** dev-only ika transaction benchmarks (high-resolution `performance.now()` in the service worker). */

function envTruthy(v: string | undefined): boolean {
  const s = String(v ?? '').toLowerCase().trim();
  return s === 'true' || s === '1' || s === 'yes';
}

export function ikaTxBenchEnabled(): boolean {
  return envTruthy(import.meta.env.VITE_IKA_TX_BENCH);
}

/** when true with `VITE_IKA_TX_BENCH`, each completed flow triggers `chrome.downloads` with one JSON file. */
export function ikaTxBenchAutoDownload(): boolean {
  return envTruthy(import.meta.env.VITE_IKA_TX_BENCH_AUTO_DOWNLOAD);
}
