import * as ed25519 from '@noble/ed25519';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { signMessageSol } from '@/background/chains/signing';
import {
  getDwalletEd25519PublicKey,
  getDwalletEd25519PublicKeyForDwalletId,
} from '@/background/chains/solana';

function hexSigToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '');
  if (h.length !== 128) throw new Error('expected 64-byte Ed25519 signature (hex)');
  return Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

/**
 * signs a Solana wire transaction with the active ED25519 dWallet (ika presign pool).
 * verifies the ika output with standard ed25519 on the serialized message (Solana RPC expectation).
 */
export async function signSolanaTransactionWire(
  wire: Uint8Array,
  opts?: { ed25519DwalletId?: string },
): Promise<Uint8Array> {
  console.warn('[chromatika][solana-tx-sign] begin', { wireLen: wire.length, edId: opts?.ed25519DwalletId });
  let vtx: VersionedTransaction;
  try {
    vtx = VersionedTransaction.deserialize(wire);
  } catch (e) {
    throw new Error(`invalid Solana transaction: ${e instanceof Error ? e.message : String(e)}`);
  }

  const messageBytes = vtx.message.serialize();
  const edId = opts?.ed25519DwalletId;
  const pubkeyBytes = edId
    ? await getDwalletEd25519PublicKeyForDwalletId(edId)
    : await getDwalletEd25519PublicKey();
  const ourPk = new PublicKey(pubkeyBytes);
  console.warn('[chromatika][solana-tx-sign] pubkey resolved', { ourPk: ourPk.toBase58() });

  const signerKeys = vtx.message.staticAccountKeys.slice(0, vtx.message.header.numRequiredSignatures);
  const signerAddrs = signerKeys.map((pk) => pk.toBase58());
  console.warn('[chromatika][solana-tx-sign] required signers', { signerAddrs, numRequired: vtx.message.header.numRequiredSignatures });
  if (!signerKeys.some((pk) => pk.equals(ourPk))) {
    throw new Error('Chromatika wallet is not a required signer for this transaction');
  }

  console.warn('[chromatika][solana-tx-sign] calling signMessageSol...', { messageBytesLen: messageBytes.length });
  const t0 = Date.now();
  const { signature } = await signMessageSol(messageBytes, edId ? { ed25519DwalletId: edId } : undefined);
  console.warn('[chromatika][solana-tx-sign] signMessageSol returned', { elapsedMs: Date.now() - t0, sigLen: signature.length });
  const sigBytes = hexSigToBytes(signature);
  if (!ed25519.verify(sigBytes, messageBytes, pubkeyBytes)) {
    throw new Error(
      'ika Ed25519 output failed Solana verification on tx message - hash/scheme mismatch vs chain',
    );
  }

  vtx.addSignature(ourPk, sigBytes);
  console.warn('[chromatika][solana-tx-sign] signature verified and added, serializing');
  return vtx.serialize();
}
