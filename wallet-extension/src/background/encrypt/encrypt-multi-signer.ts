/**
 * ephemeral Keypair partial signs for Encrypt-style multi-signer Solana txs.
 * call before ika / dWallet signing adds the user authority signature.
 */

import { Keypair, VersionedTransaction } from '@solana/web3.js';

/** deserialize, partialSign with each ephemeral keypair in order, re-serialize. */
export function applyEphemeralPartialSignsToVersionedWire(
  wire: Uint8Array,
  ephemeralSigners: Keypair[],
): Uint8Array {
  const vtx = VersionedTransaction.deserialize(wire);
  for (const kp of ephemeralSigners) {
    vtx.sign([kp]);
  }
  return vtx.serialize();
}
