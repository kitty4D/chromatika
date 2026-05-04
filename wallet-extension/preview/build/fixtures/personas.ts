/**
 * The two demo personas.
 *
 * **David** - sui-base hd vault, passkey-unlocked. Demo as a "passkey + sui defi" user.
 * Address tags `0xdavd…` / `bc1qdavd…` keep it obviously fake.
 *
 * **Toly** - solana-base seeker hardware vault (mwa-remote). Demo as a "phone-only
 * solana mpc" user. Address tags `ToLY1d…`.
 *
 * Every other fixture references these two by id so renaming or re-addressing only
 * touches one file.
 */

export const DAVID = {
  id: 'davd-0001-aaaa-bbbb-ccccdddd0001',
  label: 'David',
  baseChain: 'sui' as const,
  unlockMethod: 'passkey' as const,
  accountKind: 'hd' as const,
  // dWallet object id on sui (32-byte, 0x prefixed) - real format
  dwalletId: '0xdavd1d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8090a1b2c3d4e5f6a7b8c9d0e1f2a3b',
  capId: '0xdaC1d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8090a1b2c3d4e5f6a7b8c9d0e1f2a3b',
  addresses: {
    sui: '0xdavd1d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8090a1b2c3d4e5f6a7b8c9d0e1f2a3b',
    evm: '0xDavd1d4f5e6a7B8c9D0e1F2a3B4C5D6E7F8090a1b',
    btcP2wpkh: 'bc1qdavd1d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8090',
    btcP2tr: 'bc1pdavd1d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8090',
    aptos: '0xdavd1d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8090a1b2c3d4e5f6a7b8c9d0e1f2a3b',
    solana: 'DAVDb8c9D0e1F2a3B4C5D6E7F8090a1bC2d3E4f5G6h7J8k9L0m1N',
  },
  createdAtMs: Date.parse('2025-11-04T14:32:00Z'),
} as const;

export const TOLY = {
  id: 'toly-0001-aaaa-bbbb-ccccdddd0001',
  label: 'Toly',
  baseChain: 'solana' as const,
  unlockMethod: 'seeker' as const,
  accountKind: 'hardware' as const,
  // dWallet on solana side is a base58 PDA
  dwalletId: 'ToLY1d4f5e6a7B8c9D0e1F2a3B4C5D6E7F8090a1bC2d3E4f5G6h7J8k9',
  capId: 'ToLYC4f5e6a7B8c9D0e1F2a3B4C5D6E7F8090a1bC2d3E4f5G6h7J8',
  addresses: {
    solana: 'ToLY1d4f5e6a7B8c9D0e1F2a3B4C5D6E7F8090a1bC2d3E4f5G6h7J8k9',
    evm: '0xToLy1d4f5e6a7B8c9D0e1F2a3B4C5D6E7F8090a1b',
    btcP2wpkh: 'bc1qtoly1d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8090',
    btcP2tr: 'bc1ptoly1d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8090',
    sui: '0xtoly1d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8090a1b2c3d4e5f6a7b8c9d0e1f2a3b',
    aptos: '0xtoly1d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8090a1b2c3d4e5f6a7b8c9d0e1f2a3b',
  },
  createdAtMs: Date.parse('2025-12-19T09:14:00Z'),
} as const;

export type Persona = typeof DAVID | typeof TOLY;
