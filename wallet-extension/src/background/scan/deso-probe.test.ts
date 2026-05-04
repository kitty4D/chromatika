import { describe, expect, it } from 'vitest';
import { makeDesoProbe, buildSuperProProbes } from '@/background/scan/scan-probes';
import type { ScanCandidate } from '@/background/scan/scan-types';
import { decodeDeSoAddress, encodeDeSoAddress } from '@/background/chains/deso/deso-address';

/**
 * DeSo probe wiring tests. doesn't hit the real DeSo node - the probe's HTTP path is exercised
 * end-to-end at runtime; here we pin:
 *   1. the probe registers under the right chain kind
 *   2. `addressFor(candidate)` produces a valid base58check DeSo address from the candidate's
 *      33-byte compressed secp256k1 pubkey
 *   3. `addressFor(candidate)` returns undefined for candidates without a secp pubkey
 *      (passkey / seeker / waap / lazor identities) - so the orchestrator skips them cleanly
 */

describe('makeDesoProbe', () => {
  // 0x02 prefix + 32 bytes of x-coordinate = 33 bytes total = 66 hex chars.
  const TEST_COMPRESSED_HEX = '02a01d4cd72fcc4f1ca7c5c4c6a16c5e5f6d7e8f90112233445566778899aabbcc';
  const desoEntry = { kind: 'deso' as const, id: 'deso-mainnet', name: 'DeSo Mainnet', cluster: 'mainnet' as const };

  function fakeHdCandidate(secpHex: string | undefined): ScanCandidate {
    return {
      key: 'hd:account=0',
      accountIndex: 0,
      evmAddress: '0x000000000000000000000000000000000000dead',
      ...(secpHex ? { secp256k1CompressedHex: secpHex } : {}),
    };
  }

  it('registers as a deso-kind probe with the supplied chain id + name', () => {
    const probe = makeDesoProbe(desoEntry);
    expect(probe.kind).toBe('deso');
    expect(probe.chainId).toBe('deso-mainnet');
    expect(probe.chainName).toBe('DeSo Mainnet');
  });

  it('addressFor produces a valid mainnet DeSo address from a 33-byte compressed pubkey', () => {
    const probe = makeDesoProbe(desoEntry);
    const addr = probe.addressFor(fakeHdCandidate(TEST_COMPRESSED_HEX));
    expect(addr).toBeDefined();
    // round-trip: decoding the produced address yields back the 33-byte pubkey we started with.
    const decoded = decodeDeSoAddress(addr!, 'mainnet');
    expect(decoded.length).toBe(33);
    const decodedHex = Array.from(decoded).map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(decodedHex).toBe(TEST_COMPRESSED_HEX);
  });

  it('addressFor matches encodeDeSoAddress directly on the same bytes (no wrapping drift)', () => {
    const probe = makeDesoProbe(desoEntry);
    const addr = probe.addressFor(fakeHdCandidate(TEST_COMPRESSED_HEX));
    const bytes = new Uint8Array(33);
    for (let i = 0; i < 33; i++) bytes[i] = parseInt(TEST_COMPRESSED_HEX.slice(i * 2, i * 2 + 2), 16);
    expect(addr).toBe(encodeDeSoAddress(bytes, 'mainnet'));
  });

  it('addressFor returns undefined for non-HD candidates (no secp pubkey)', () => {
    const probe = makeDesoProbe(desoEntry);
    const passkeyCandidate: ScanCandidate = {
      key: 'passkey:single',
      suiAddress: '0xdeadbeef',
    };
    expect(probe.addressFor(passkeyCandidate)).toBeUndefined();
  });

  it('addressFor returns undefined when the secp hex is the wrong length', () => {
    const probe = makeDesoProbe(desoEntry);
    const tooShort = fakeHdCandidate('02ab');
    expect(probe.addressFor(tooShort)).toBeUndefined();
    const tooLong = fakeHdCandidate(`${TEST_COMPRESSED_HEX}00`);
    expect(probe.addressFor(tooLong)).toBeUndefined();
  });

  it('addressFor returns undefined when the compressed prefix byte is invalid (not 0x02 / 0x03)', () => {
    // encodeDeSoAddress throws for invalid prefix; helper catches and returns undefined.
    const probe = makeDesoProbe(desoEntry);
    const badPrefix = fakeHdCandidate(`04${TEST_COMPRESSED_HEX.slice(2)}`);
    expect(probe.addressFor(badPrefix)).toBeUndefined();
  });
});

describe('buildSuperProProbes wires the DeSo entry', () => {
  it('returns a deso probe when `deso-mainnet` is in the requested chain ids', () => {
    const probes = buildSuperProProbes(['deso-mainnet']);
    expect(probes).toHaveLength(1);
    expect(probes[0]!.kind).toBe('deso');
    expect(probes[0]!.chainId).toBe('deso-mainnet');
  });

  it('returns no probes for an empty selection', () => {
    expect(buildSuperProProbes([])).toEqual([]);
  });

  it('mixes evm + deso when both ids are requested', () => {
    const probes = buildSuperProProbes(['evm-324', 'deso-mainnet']);
    const kinds = probes.map((p) => p.kind).sort();
    expect(kinds).toEqual(['deso', 'evm']);
  });
});
