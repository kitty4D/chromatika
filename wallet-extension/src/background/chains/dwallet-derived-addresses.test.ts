import { describe, it, expect } from 'vitest';
import { deriveChainAddressesFromActivePublicOutput } from '@/background/chains/dwallet-derived-addresses';

describe('deriveChainAddressesFromActivePublicOutput', () => {
  it('uses raw 32-byte key when ika wasm rejects bytes (Sol pre-alpha DWallet account)', async () => {
    const raw32 = new Uint8Array(32);
    raw32[0] = 9;
    for (let i = 1; i < 32; i++) raw32[i] = i;
    const r = await deriveChainAddressesFromActivePublicOutput('ED25519', raw32, 'mainnet');
    expect(r.solana).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(r.sui).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(r.aptos).toMatch(/^0x[0-9a-f]{64}$/i);
  });
});
