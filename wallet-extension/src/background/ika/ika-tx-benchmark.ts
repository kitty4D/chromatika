/**
 * precise per-phase timings for ika-related flows (service worker, `performance.now()`).
 * one serialized record per run; optional immediate download via `VITE_IKA_TX_BENCH_AUTO_DOWNLOAD`.
 */

import { ikaTxBenchAutoDownload } from '@/lib/ika-tx-bench-env';

export type IkaTxBenchPhaseRow = {
  phase: string;
  detail?: string;
  perfStart: number;
  perfEnd: number;
  ms: number;
  wallStartIso: string;
  wallEndIso: string;
  threw?: string;
};

export type IkaTxBenchRecordV1 = {
  schema: 'chromatika.ika_tx_bench.v1';
  runId: string;
  flow: string;
  context: Record<string, unknown>;
  phases: IkaTxBenchPhaseRow[];
  /** `performance.now()` span from session construction to finalize (wall-aligned via context). */
  totalPerfMs: number;
  wallStartedIso: string;
  wallFinishedIso: string;
  outcome: { ok: true; txHash: string } | { ok: false; error: string };
};

export class IkaTxBenchSession {
  readonly runId = crypto.randomUUID();
  readonly phases: IkaTxBenchPhaseRow[] = [];
  private readonly perf0 = performance.now();
  private readonly wall0 = Date.now();
  readonly wallStartedIso = new Date(this.wall0).toISOString();

  constructor(
    readonly flow: string,
    readonly context: Record<string, unknown> = {},
  ) {
    console.info('[chromatika ika bench] run_start', {
      runId: this.runId,
      flow: this.flow,
      context: this.context,
    });
  }

  private wallIso(perfT: number): string {
    return new Date(this.wall0 + (perfT - this.perf0)).toISOString();
  }

  private logPhaseEnd(row: IkaTxBenchPhaseRow): void {
    const line = {
      runId: this.runId,
      phase: row.phase,
      ms: row.ms,
      detail: row.detail,
      threw: row.threw,
    };
    console.info('[chromatika ika bench] phase', line);
  }

  /**
   * measures one awaited segment. `perfStart` / `perfEnd` are monotonic same-origin values
   * (not UI timers); wall ISO fields align them to calendar time via the session start anchor.
   */
  async measure<T>(phase: string, detail: string | undefined, fn: () => T | Promise<T>): Promise<T> {
    const perfStart = performance.now();
    const wallStartIso = this.wallIso(perfStart);
    try {
      const out = await fn();
      const perfEnd = performance.now();
      const row: IkaTxBenchPhaseRow = {
        phase,
        detail,
        perfStart,
        perfEnd,
        ms: perfEnd - perfStart,
        wallStartIso,
        wallEndIso: this.wallIso(perfEnd),
      };
      this.phases.push(row);
      this.logPhaseEnd(row);
      return out;
    } catch (e) {
      const perfEnd = performance.now();
      const threw = e instanceof Error ? e.message : String(e);
      const row: IkaTxBenchPhaseRow = {
        phase,
        detail,
        perfStart,
        perfEnd,
        ms: perfEnd - perfStart,
        wallStartIso,
        wallEndIso: this.wallIso(perfEnd),
        threw,
      };
      this.phases.push(row);
      this.logPhaseEnd(row);
      throw e;
    }
  }

  /** sync work bounded in one phase (no await inside `fn`). */
  measureSync<T>(phase: string, detail: string | undefined, fn: () => T): T {
    const perfStart = performance.now();
    const wallStartIso = this.wallIso(perfStart);
    try {
      const out = fn();
      const perfEnd = performance.now();
      const row: IkaTxBenchPhaseRow = {
        phase,
        detail,
        perfStart,
        perfEnd,
        ms: perfEnd - perfStart,
        wallStartIso,
        wallEndIso: this.wallIso(perfEnd),
      };
      this.phases.push(row);
      this.logPhaseEnd(row);
      return out;
    } catch (e) {
      const perfEnd = performance.now();
      const threw = e instanceof Error ? e.message : String(e);
      const row: IkaTxBenchPhaseRow = {
        phase,
        detail,
        perfStart,
        perfEnd,
        ms: perfEnd - perfStart,
        wallStartIso,
        wallEndIso: this.wallIso(perfEnd),
        threw,
      };
      this.phases.push(row);
      this.logPhaseEnd(row);
      throw e;
    }
  }

  async finalize(outcome: IkaTxBenchRecordV1['outcome']): Promise<void> {
    const wallFinishedIso = new Date().toISOString();
    const perfEnd = performance.now();
    const record: IkaTxBenchRecordV1 = {
      schema: 'chromatika.ika_tx_bench.v1',
      runId: this.runId,
      flow: this.flow,
      context: this.context,
      phases: this.phases,
      totalPerfMs: perfEnd - this.perf0,
      wallStartedIso: this.wallStartedIso,
      wallFinishedIso,
      outcome,
    };

    if (!ikaTxBenchAutoDownload()) {
      try {
        console.info('[chromatika ika bench] run_complete', JSON.stringify(record));
      } catch (ser) {
        console.error('[chromatika ika bench] run_complete (serialize failed)', ser, record);
      }
      return;
    }
    if (typeof chrome === 'undefined' || !chrome.downloads?.download) return;

    let json: string;
    try {
      json = `${JSON.stringify(record, null, 2)}\n`;
    } catch (ser) {
      console.error('[chromatika ika bench] download serialize failed', ser, record);
      return;
    }
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const safeFlow = this.flow.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 48);
    const shortId = this.runId.replace(/-/g, '').slice(0, 12);
    try {
      await chrome.downloads.download({
        url,
        filename: `chromatika-ika-bench-${safeFlow}-${shortId}.json`,
        saveAs: false,
        conflictAction: 'uniquify',
      });
    } finally {
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 45_000);
    }
  }
}
