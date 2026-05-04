import { describe, expect, it } from 'vitest';
import { makeCosmosProbe, buildSuperProProbes } from '@/background/scan/scan-probes';
import type { ScanCandidate } from '@/background/scan/scan-types';
import { decodeCosmosAddress } from '@/background/chains/cosmos/cosmos-address';

/**
 * Cosmos probe wiring tests. doesn't hit a real node - the HTTP path runs end-to-end at runtime.
 * here we pin:
 *   1. probe registers under the right chain kind / id / name
 *   2. addressFor produces a valid bech32 address with the right HRP from the candidate's
 *      33-byte compressed secp256k1 pubkey
 *   3. addressFor returns undefined for non-HD candidates
 */

describe('makeCosmosProbe', () => {
  const TEST_COMPRESSED_HEX = '02a01d4cd72fcc4f1ca7c5c4c6a16c5e5f6d7e8f90112233445566778899aabbcc';
  const cosmosHubEntry = {
    kind: 'cosmos' as const,
    id: 'cosmos-hub',
    name: 'Cosmos Hub',
    restUrl: 'https://cosmos-rest.example.com',
    bech32Hrp: 'cosmos',
    nativeDenom: 'uatom',
    nativeDecimals: 6,
    nativeSymbol: 'ATOM',
  };

  function fakeHdCandidate(secpHex: string | undefined): ScanCandidate {
    return {
      key: 'hd:account=0',
      accountIndex: 0,
      ...(secpHex ? { secp256k1CompressedHex: secpHex } : {}),
    };
  }

  it('registers as a cosmos-kind probe with the supplied chain id + name', () => {
    const probe = makeCosmosProbe(cosmosHubEntry);
    expect(probe.kind).toBe('cosmos');
    expect(probe.chainId).toBe('cosmos-hub');
    expect(probe.chainName).toBe('Cosmos Hub');
  });

  it('addressFor produces a valid bech32 address with the chain HRP', () => {
    const probe = makeCosmosProbe(cosmosHubEntry);
    const addr = probe.addressFor(fakeHdCandidate(TEST_COMPRESSED_HEX));
    expect(addr).toBeDefined();
    expect(addr!.startsWith('cosmos1')).toBe(true);
    // round-trip via decodeCosmosAddress to verify the HRP + 20-byte hash payload.
    const decoded = decodeCosmosAddress(addr!, 'cosmos');
    expect(decoded.length).toBe(20);
  });

  it('different HRPs (osmo / juno) produce different addresses for the same candidate', () => {
    const cosmos = makeCosmosProbe(cosmosHubEntry);
    const osmo = makeCosmosProbe({ ...cosmosHubEntry, id: 'osmosis', name: 'Osmosis', bech32Hrp: 'osmo' });
    const juno = makeCosmosProbe({ ...cosmosHubEntry, id: 'juno', name: 'Juno', bech32Hrp: 'juno' });
    const c = fakeHdCandidate(TEST_COMPRESSED_HEX);
    expect(cosmos.addressFor(c)).not.toBe(osmo.addressFor(c));
    expect(osmo.addressFor(c)!.startsWith('osmo1')).toBe(true);
    expect(juno.addressFor(c)!.startsWith('juno1')).toBe(true);
  });

  it('addressFor returns undefined for non-HD candidates (no secp pubkey)', () => {
    const probe = makeCosmosProbe(cosmosHubEntry);
    const passkey: ScanCandidate = { key: 'passkey:single', suiAddress: '0xdead' };
    expect(probe.addressFor(passkey)).toBeUndefined();
  });

  it('addressFor returns undefined when secp hex is the wrong length or has an invalid prefix', () => {
    const probe = makeCosmosProbe(cosmosHubEntry);
    expect(probe.addressFor(fakeHdCandidate('02ab'))).toBeUndefined();
    expect(probe.addressFor(fakeHdCandidate(`04${TEST_COMPRESSED_HEX.slice(2)}`))).toBeUndefined();
  });
});

describe('buildSuperProProbes wires the cosmos catalog', () => {
  it('returns probes for each opted-in cosmos chain id', () => {
    const probes = buildSuperProProbes(['cosmos-hub', 'osmosis']);
    const kinds = probes.map((p) => p.kind);
    const ids = probes.map((p) => p.chainId).sort();
    expect(kinds.every((k) => k === 'cosmos')).toBe(true);
    expect(ids).toEqual(['cosmos-hub', 'osmosis']);
  });

  it('mixes evm + cosmos when both ids are requested', () => {
    const probes = buildSuperProProbes(['evm-324', 'cosmos-hub']);
    const kinds = probes.map((p) => p.kind).sort();
    expect(kinds).toEqual(['cosmos', 'evm']);
  });
});
