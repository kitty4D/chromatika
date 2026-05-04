/**
 * Mysten-standard `signPersonalMessage` digest construction. the dapp-bridge handler at
 * `dapp-bridge/sui.ts:sui_signPersonalMessage` calls `buildSuiPersonalMessageDigest` to derive
 * the 32-byte BLAKE2b digest that ika MPC then ed25519-signs.
 *
 * reference: Mysten's `Ed25519Keypair.signPersonalMessage`:
 *   ```
 *   const intentMessage = messageWithIntent(
 *     'PersonalMessage',
 *     bcs.vector(bcs.U8).serialize(message).toBytes(),
 *   );
 *   const digest = blake2b(intentMessage, { dkLen: 32 });
 *   const signature = ed25519_sign(privkey, digest);
 *   ```
 *
 * pure function. no session / chrome / network dependency, fully unit-testable.
 */

import { blake2b } from '@noble/hashes/blake2.js';
import { bcs } from '@mysten/sui/bcs';
import { messageWithIntent } from '@mysten/sui/cryptography';

/**
 * build the 32-byte digest a Mysten verifier expects for a given personal-message.
 * steps:
 *   1. BCS-encode the message bytes as `vector<u8>` (length-prefixed).
 *   2. prepend the PersonalMessage intent prefix (`[3, 0, 0]`).
 *   3. BLAKE2b-256 hash the result.
 *
 * the dapp-bridge handler hands this digest to `signMessageSol` (ika ed25519 MPC) to produce a
 * signature that Mysten's `verifyPersonalMessageSignature` accepts.
 */
export function buildSuiPersonalMessageDigest(messageBytes: Uint8Array): Uint8Array {
  const bcsEncoded = bcs.vector(bcs.U8).serialize(messageBytes).toBytes();
  const intentMessage = messageWithIntent('PersonalMessage', bcsEncoded);
  return blake2b(intentMessage, { dkLen: 32 });
}
