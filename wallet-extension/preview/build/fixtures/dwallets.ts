/**
 * dWallet caps fixture (`listOwnedDWalletCaps` return shape).
 *
 * David's vault is sui-base so its dWallets are Sui object ids. Two dWallets cover
 * both ika curves:
 *  - SECP256K1: cross-chain evm + btc signing
 *  - ED25519:   sui + solana + aptos
 */

import { DAVID, TOLY } from './personas';

export const DWALLET_CAPS_DAVID = [
  {
    capObjectId: '0xdaC1d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8090a1b2c3d4e5f6a7b8c9d0e1f2a3b',
    dwalletId: '0xdavd1d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8090a1b2c3d4e5f6a7b8c9d0e1f2a3b',
    curve: 'SECP256K1' as const,
    status: 'Active' as const,
    needsZeroTrustCompletion: false,
    chainAddresses: {
      evm: DAVID.addresses.evm,
      btcP2wpkh: DAVID.addresses.btcP2wpkh,
      btcP2tr: DAVID.addresses.btcP2tr,
    },
  },
  {
    capObjectId: '0xda20d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8090a1b2c3d4e5f6a7b8c9d0e1f2a3b',
    dwalletId: '0xda22d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8090a1b2c3d4e5f6a7b8c9d0e1f2a3b',
    curve: 'ED25519' as const,
    status: 'Active' as const,
    needsZeroTrustCompletion: false,
    chainAddresses: {
      sui: DAVID.addresses.sui,
      solana: DAVID.addresses.solana,
      aptos: DAVID.addresses.aptos,
    },
  },
];

export const DWALLET_CAPS_TOLY = [
  {
    capObjectId: 'ToLY_secp_C4f5e6a7B8c9D0e1F2a3B4C5D6E7F8090a1bC2d3E4f5G6h7J8',
    dwalletId: 'ToLY_secp_dwallet_0xdeadbeef0123456789abcdef0123456789abcdef',
    curve: 'SECP256K1' as const,
    status: 'Active' as const,
    needsZeroTrustCompletion: false,
    chainAddresses: {
      evm: TOLY.addresses.evm,
      btcP2wpkh: TOLY.addresses.btcP2wpkh,
      btcP2tr: TOLY.addresses.btcP2tr,
    },
  },
  {
    capObjectId: 'ToLY_eddsa_dWallet_e6a7B8c9D0e1F2a3B4C5D6E7F8090a1bC2d3E4f5',
    dwalletId: TOLY.dwalletId,
    curve: 'ED25519' as const,
    status: 'Active' as const,
    needsZeroTrustCompletion: false,
    chainAddresses: {
      solana: TOLY.addresses.solana,
      sui: TOLY.addresses.sui,
      aptos: TOLY.addresses.aptos,
    },
  },
];

export const VAULT_SUMMARIES = [
  {
    id: DAVID.id,
    label: DAVID.label,
    baseChain: DAVID.baseChain,
    accountKind: DAVID.accountKind,
    createdAtMs: DAVID.createdAtMs,
    dwalletCount: 2,
    suiAddress0: DAVID.addresses.sui,
    solanaAddress0: DAVID.addresses.solana,
    ikaKeysReady: true,
  },
  {
    id: TOLY.id,
    label: TOLY.label,
    baseChain: TOLY.baseChain,
    accountKind: TOLY.accountKind,
    createdAtMs: TOLY.createdAtMs,
    dwalletCount: 2,
    solanaMobileHardwareBridge: 'mwa-remote' as const,
    suiAddress0: TOLY.addresses.sui,
    solanaAddress0: TOLY.addresses.solana,
    ikaKeysReady: true,
  },
];

/** address-book shape returned by `trpc.dwalletAddressBook` - WalletPage reads SECP256K1.dwalletId */
export const DWALLET_ADDRESS_BOOK = {
  SECP256K1: {
    dwalletId: DWALLET_CAPS_DAVID[0].dwalletId,
    addresses: DWALLET_CAPS_DAVID[0].chainAddresses,
  },
  ED25519: {
    dwalletId: DWALLET_CAPS_DAVID[1].dwalletId,
    addresses: DWALLET_CAPS_DAVID[1].chainAddresses,
  },
};

export const DWALLET_DISPLAY_NAMES = {
  names: {
    [DWALLET_CAPS_DAVID[0].dwalletId]: 'David · evm + btc',
    [DWALLET_CAPS_DAVID[1].dwalletId]: 'David · sui + solana',
  },
};

export const DWALLET_CARD_ORDER = {
  orderedIds: DWALLET_CAPS_DAVID.map((c) => c.dwalletId),
};

/** sample evm token balances - ETH + USDC + a token with non-zero balance */
export const EVM_TOKEN_BALANCES = {
  tokens: [
    { symbol: 'ETH', name: 'Ethereum', balanceFormatted: '0.5000', usdValue: 1234.56, contract: null, logo: null, decimals: 18 },
    { symbol: 'USDC', name: 'USD Coin', balanceFormatted: '500.00', usdValue: 500.0, contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', logo: null, decimals: 6 },
    { symbol: 'WETH', name: 'Wrapped Ether', balanceFormatted: '0.123', usdValue: 304.0, contract: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', logo: null, decimals: 18 },
  ],
};

/** sample portfolio rail balances per chain */
export const PORTFOLIO_RAIL_BALANCES_SUI = [
  { symbol: 'SUI', balanceFormatted: '12.5000', usdValue: 21.13 },
  { symbol: 'IKA', balanceFormatted: '892.48', usdValue: 0.04 },
  { symbol: 'WAL', balanceFormatted: '38.21', usdValue: 12.94 },
];

export const PORTFOLIO_RAIL_BALANCES_SOLANA = [
  { symbol: 'SOL', balanceFormatted: '0.0', usdValue: 0 },
];

export const PORTFOLIO_RAIL_BALANCES_BTC = [
  { symbol: 'BTC', balanceFormatted: '0.0125', usdValue: 825.0 },
];

export const PORTFOLIO_RAIL_BALANCES_APTOS = [
  { symbol: 'APT', balanceFormatted: '0.0', usdValue: 0 },
];
