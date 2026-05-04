import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runScan } from '@/background/scan/scan-orchestrator';
import * as probesModule from '@/background/scan/scan-probes';
import type { ChainProbe } from '@/background/scan/scan-types';

/**
 * orchestrator-level tests. probes are stubbed via `buildDefaultProbes` / `buildSuperProProbes`
 * spies so we don't hit real RPCs. derivation helpers (`buildHdCandidates`, etc.) are exercised
 * for real - they're pure functions.
 */

function makeFakeProbe(overrides: Partial<{
  chainId: string;
  chainName: string;
  kind: ChainProbe['kind'];
  applyToSui: boolean;
  applyToSolana: boolean;
  balance: bigint;
  txCount: number;
  hasActivity: boolean;
}> = {}): ChainProbe {
  const {
    chainId = 'fake-chain',
    chainName = 'fake',
    kind = 'sui',
    applyToSui = true,
    applyToSolana = false,
    balance = 0n,
    txCount = 0,
    hasActivity = false,
  } = overrides;
  return {
    chainId,
    chainName,
    kind,
    addressFor: (c) => {
      if (applyToSui && c.suiAddress) return c.suiAddress;
      if (applyToSolana && c.solanaAddress) return c.solanaAddress;
      return undefined;
    },
    probe: async () => ({
      balanceSmallest: balance,
      balanceDisplay: `${balance.toString()} ${chainName.toUpperCase()}`,
      txCount,
      hasActivity,
    }),
  };
}

beforeEach(() => {
  vi.spyOn(probesModule, 'buildDefaultProbes').mockReturnValue([]);
  vi.spyOn(probesModule, 'buildSuperProProbes').mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runScan - identity methods', () => {
  it('passkey scan returns exactly one candidate row', async () => {
    const r = await runScan(
      { method: 'passkey', suiAddress: '0xpasskeysuiaddr' },
      { defaults: false },
    );
    expect(r.method).toBe('passkey');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.candidate.suiAddress).toBe('0xpasskeysuiaddr');
    expect(r.rows[0]!.isDefaultSlot).toBe(true);
  });

  it('default slot is always suggested even when empty', async () => {
    const r = await runScan(
      { method: 'passkey', suiAddress: '0xidle' },
      { defaults: false },
    );
    expect(r.suggestedKeys).toContain(r.rows[0]!.candidate.key);
  });

  it('marks row hasAnyActivity when a probe reports balance > 0', async () => {
    vi.spyOn(probesModule, 'buildDefaultProbes').mockReturnValue([
      makeFakeProbe({ balance: 100n, hasActivity: true }),
    ]);
    const r = await runScan(
      { method: 'passkey', suiAddress: '0xactive' },
      { defaults: true },
    );
    expect(r.rows[0]!.hasAnyActivity).toBe(true);
    expect(r.rows[0]!.probes).toHaveLength(1);
    expect(r.rows[0]!.probes[0]!.balanceSmallest).toBe(100n);
  });
});

describe('runScan - HD account index gap-limit search', () => {
  const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('stops after gap consecutive empty slots (default gap = 5)', async () => {
    // no probes = every row is empty. should stop at index 4 (0,1,2,3,4 = 5 empty slots) or sooner.
    const r = await runScan({ method: 'hd', mnemonic: TEST_MNEMONIC }, { defaults: false });
    // first hit hasn't happened, lastHitIdx === -1, so we cap at gap rows.
    expect(r.rows.length).toBeLessThanOrEqual(5);
    expect(r.rows[0]!.isDefaultSlot).toBe(true);
  });

  it('continues past the last hit until gap consecutive empties past it', async () => {
    // simulate: any candidate with accountIndex < 2 has activity, then no activity.
    let callCount = 0;
    const probe = makeFakeProbe({ chainId: 'sim', chainName: 'sim' });
    probe.probe = async () => {
      callCount++;
      // first 2 calls = with-activity, rest = empty. addresses are derived sequentially per accountIdx.
      const isHit = callCount <= 2;
      return {
        balanceSmallest: isHit ? 50n : 0n,
        hasActivity: isHit,
        txCount: isHit ? 1 : 0,
      };
    };
    vi.spyOn(probesModule, 'buildDefaultProbes').mockReturnValue([probe]);
    const r = await runScan({ method: 'hd', mnemonic: TEST_MNEMONIC }, { defaults: true }, { accountIndexGap: 3 });
    // last hit at index 1 (call #2), gap=3 means scan continues to index 4 (3 empties past last hit).
    // expected at most 5 rows scanned (0..4).
    expect(r.rows.length).toBeLessThanOrEqual(5);
    expect(r.rows.length).toBeGreaterThanOrEqual(2);
    const activeRows = r.rows.filter((row) => row.hasAnyActivity);
    expect(activeRows.length).toBe(2);
  });

  it('always emits the default slot (account 0) even when fully empty', async () => {
    const r = await runScan({ method: 'hd', mnemonic: TEST_MNEMONIC }, { defaults: false });
    expect(r.rows[0]).toBeDefined();
    expect(r.rows[0]!.candidate.accountIndex).toBe(0);
    expect(r.rows[0]!.isDefaultSlot).toBe(true);
  });

  it('warnings array is empty when no probe errors', async () => {
    const r = await runScan({ method: 'passkey', suiAddress: '0x1' }, { defaults: false });
    expect(r.warnings).toEqual([]);
  });

  it('captures probe rejections as warnings without aborting the scan', async () => {
    const failing: ChainProbe = {
      chainId: 'broken',
      chainName: 'broken-chain',
      kind: 'evm',
      addressFor: (c) => c.suiAddress, // pretend it accepts the sui address
      probe: async () => {
        throw new Error('rpc 503');
      },
    };
    vi.spyOn(probesModule, 'buildDefaultProbes').mockReturnValue([failing]);
    const r = await runScan({ method: 'passkey', suiAddress: '0x1' }, { defaults: true });
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain('rpc 503');
    // probe still emitted a row entry with error metadata.
    expect(r.rows[0]!.probes[0]!.error).toContain('rpc 503');
    // hasActivity stays false despite the error.
    expect(r.rows[0]!.hasAnyActivity).toBe(false);
  });
});

describe('runScan - elapsedMs accounting', () => {
  it('reports a non-negative elapsed time', async () => {
    const r = await runScan({ method: 'passkey', suiAddress: '0x1' }, { defaults: false });
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(r.elapsedMs).toBeLessThan(60_000); // sanity bound
  });
});

describe('runScan - lazor placeholder PDA note', () => {
  it('emits a clear setup note when lazor PDA is not valid base58 (v1 placeholder)', async () => {
    // chromatika v1 stores the lazor passkey P-256 pubkey (base64) in `lazorSmartWalletPubkeyB58`
    // as a placeholder. without this guard the solana probe throws "Non-base58 character" via
    // `new PublicKey()`. expectations: candidate has no solanaAddress (probe skipped), result
    // carries a one-line note pointing at the underlying placeholder issue + the proper fix.
    const PASSKEY_B64 = 'AmZcVgZOSvWj/upzz98BZTxtNtSAMbrZcm8rLUEksKE0';
    const r = await runScan(
      { method: 'lazor', lazorSmartWalletPubkeyB58: PASSKEY_B64 },
      { defaults: false },
    );
    expect(r.notes.length).toBeGreaterThan(0);
    expect(r.notes[0]!).toContain('lazor smart-wallet PDA not yet resolved');
    expect(r.notes[0]!).toContain('getSmartWalletByCredentialHash');
    expect(r.warnings.length).toBe(0); // clean - no cryptic Non-base58 warning
    expect(r.rows[0]!.candidate.solanaAddress).toBeUndefined();
  });

  it('does NOT emit the placeholder note when lazor PDA is valid base58', async () => {
    const VALID_PDA = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const r = await runScan(
      { method: 'lazor', lazorSmartWalletPubkeyB58: VALID_PDA },
      { defaults: false },
    );
    // notes is always present (added to the type) but should be empty for the happy path.
    expect(r.notes).toEqual([]);
    expect(r.rows[0]!.candidate.solanaAddress).toBe(VALID_PDA);
  });
});
