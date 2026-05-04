/**
 * helpers for waiting on Encrypt executor / account state (Solana RPC only).
 * offsets are example-driven; adjust when aligning with on-chain layout changes.
 */

import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';

export const ENCRYPT_POLL_DEFAULT_INTERVAL_MS = 400;
export const ENCRYPT_POLL_DEFAULT_MAX_MS = 60_000;

/**
 * poll `getAccountInfo` until `data[offset] !== pendingByte` or timeout.
 * counter-style layouts often use a status byte near the start of account data.
 */
export async function pollAccountDataByteNotEqual(opts: {
  connection: Connection;
  address: PublicKey;
  offset: number;
  pendingByte: number;
  intervalMs?: number;
  maxWaitMs?: number;
}): Promise<boolean> {
  const interval = opts.intervalMs ?? ENCRYPT_POLL_DEFAULT_INTERVAL_MS;
  const max = opts.maxWaitMs ?? ENCRYPT_POLL_DEFAULT_MAX_MS;
  const start = Date.now();
  for (;;) {
    const ai = await opts.connection.getAccountInfo(opts.address, opts.connection.commitment ?? 'confirmed');
    const d = ai?.data;
    if (d && d.length > opts.offset && d[opts.offset] !== opts.pendingByte) {
      return true;
    }
    if (Date.now() - start > max) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}
