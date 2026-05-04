/**
 * Activity history fixture - 10 rows showing David <-> Toly relationship plus a few
 * outside counterparties + a dapp interaction. Covers every chip the row template
 * renders: status colors, encrypted-note badge, dapp origin tag, hidden-pc badge.
 *
 * Timestamps are anchored to "now - X" computed at module load so the demo always
 * reads as fresh.
 */

import { DAVID, TOLY } from './personas';

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const ACTIVITY_DAVID = [
  // most recent: pending-style (we only have success/failure - skip pending and use success)
  {
    digest: '0xabc123ToLY7f88a9b0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f70819',
    timestampMs: NOW - 30 * MIN,
    type: 'received' as const,
    status: 'success' as const,
    chain: 'sui' as const,
    fromAddress: TOLY.addresses.sui,
    label: 'Received 5 SUI from Toly',
    signedByThisWallet: false,
  },
  {
    digest: '0x0e1d2c3b4a59687766554433221100ffeeddccbbaa99887766554433221100zz',
    timestampMs: NOW - 2 * HOUR,
    type: 'sent' as const,
    status: 'success' as const,
    chain: 'sui' as const,
    fromAddress: DAVID.addresses.sui,
    label: 'Sent 100 USDC to Toly',
    signedByThisWallet: true,
    hasEncryptedNote: true,
  },
  {
    digest: 'AfTeRm4thSiGnAtUrEh3R3F0RaSwApR0utE4nDSwpFr0mDavidT0wal11c0in',
    timestampMs: NOW - 5 * HOUR,
    type: 'contract' as const,
    status: 'success' as const,
    chain: 'sui' as const,
    fromAddress: DAVID.addresses.sui,
    label: 'Swap: 50 USDC -> 12.34 SUI',
    origin: 'https://aftermath.finance',
    signedByThisWallet: true,
  },
  {
    digest: '0xdeadbeef0011223344556677889900aabbccddeeff112233445566778899ZZ',
    timestampMs: NOW - 1 * DAY,
    type: 'received' as const,
    status: 'success' as const,
    chain: 'evm' as const,
    fromAddress: '0xToLy1d4f5e6a7B8c9D0e1F2a3B4C5D6E7F8090a1b',
    label: 'Received 0.5 ETH from Toly',
    signedByThisWallet: false,
  },
  {
    digest: '5oLaNaT0lyT0DAVDP4ymENT5oMETHiNgL0NgB4SE58HEr3FoR3vEryd4yDeM0',
    timestampMs: NOW - 1.5 * DAY,
    type: 'sent' as const,
    status: 'success' as const,
    chain: 'solana' as const,
    fromAddress: DAVID.addresses.solana,
    label: 'Sent 12.5 SOL to Toly',
    origin: 'https://jup.ag',
    signedByThisWallet: true,
    hasEncryptedNote: true,
  },
  {
    digest: '0xpriv4t3p4ym3ntl4y3rwr4pp1nguscdblockch41nh1dd3ns3nd3rul3sok',
    timestampMs: NOW - 2 * DAY,
    type: 'contract' as const,
    status: 'success' as const,
    chain: 'sui' as const,
    fromAddress: DAVID.addresses.sui,
    label: 'private send · pcUSDC',
    recordKind: 'pc-transfer-hidden',
    signedByThisWallet: true,
  },
  {
    digest: '0xfailedeth1234567abcdef000111222333444555666777888999aaabbbccc',
    timestampMs: NOW - 3 * DAY,
    type: 'sent' as const,
    status: 'failure' as const,
    chain: 'evm' as const,
    fromAddress: DAVID.addresses.evm,
    label: 'Failed: send 1 ETH (gas underpriced)',
    signedByThisWallet: true,
  },
  {
    digest: 'b1tc01n7r4nsf3ru57x1d000111222333444555666777888999aaabbbcccdd',
    timestampMs: NOW - 4 * DAY,
    type: 'received' as const,
    status: 'success' as const,
    chain: 'bitcoin' as const,
    fromAddress: 'bc1qoutsidesendertoldhimtosendmesomesats',
    label: 'Received 0.0125 BTC',
    signedByThisWallet: false,
  },
  {
    digest: '0xdappappr0v4l1ka5tak1ngm3ssaging123abc456def789ghi000111222333',
    timestampMs: NOW - 5 * DAY,
    type: 'contract' as const,
    status: 'success' as const,
    chain: 'sui' as const,
    fromAddress: DAVID.addresses.sui,
    label: 'Stake Ika to validator (dWallet Labs)',
    origin: 'https://stake.ika.xyz',
    signedByThisWallet: true,
  },
  {
    digest: '0x0lds3ndtod4v1d5fr13ndshr0mt010n44pxsendt0c0untrp4rty0utgo1ng',
    timestampMs: NOW - 7 * DAY,
    type: 'sent' as const,
    status: 'success' as const,
    chain: 'sui' as const,
    fromAddress: DAVID.addresses.sui,
    label: 'Sent 25 SUI to friend (0x12ab…3cde)',
    signedByThisWallet: true,
  },
];
