/**
 * x402 Solana exact-scheme signer: **ika MPC path**.
 *
 * signs the x402 versioned tx via `signMessageSol` (the existing ika ED25519 dWallet sign
 * path). the address that pays USDC = the dWallet's derived Solana address, the same one
 * dapps see. used when no WalletConnect Seeker / phone wallet is paired on the active vault.
 *
 * for the WC-paired path (Seeker IS the signer, ika bypassed), see
 * `x402-walletconnect-signer.ts`. the two share `x402-solana-build.ts` for the unsigned tx
 * assembly + canonical wire fields; only the signing primitive differs.
 *
 * spec: `github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md`.
 */

import { PublicKey } from '@solana/web3.js';
import * as ed25519 from '@noble/ed25519';
import { base58 } from '@scure/base';
import {
  getDwalletEd25519PublicKey,
  getDwalletEd25519PublicKeyForDwalletId,
  getSolanaAddress,
} from '@/background/chains/solana';
import { signMessageSol } from '@/background/chains/signing';
import {
  X402_HEADER_PAYMENT_SIGNATURE,
  X402_VERSION,
  encodeBase64Json,
  type PaymentPayload,
  type PaymentRequirements,
  type SolanaExactPayload,
} from './x402-types';
import { buildX402VersionedTx, bufferToBase64 } from './x402-solana-build';

export type SolanaSignResult = {
  /** PaymentPayload envelope ready to be base64-encoded into the PAYMENT-SIGNATURE header. */
  paymentPayload: PaymentPayload;
  /** Pre-encoded value for the PAYMENT-SIGNATURE header (base64 of the envelope). */
  headerValue: string;
  /** Header name to set: 'payment-signature'. */
  headerName: typeof X402_HEADER_PAYMENT_SIGNATURE;
  /** Echo of the nonce / memo string we placed in the Memo instruction (for receipt records). */
  memoText: string;
  /** ATA used for the source side; surfaced for receipts + UI display. */
  sourceAta: string;
  /** ATA used for the destination side; surfaced for receipts + UI display. */
  destAta: string;
  /** facilitator wallet that will pay Solana fees. */
  feePayer: string;
};

export type SolanaSignArgs = {
  requirements: PaymentRequirements;
  /**
   * Optional override of the dWallet id whose ed25519 key signs. Defaults to the active
   * vault's ed25519 dWallet (the same one that drives all other Solana signing).
   */
  ed25519DwalletId?: string;
};

/**
 * Build + partial-sign the Solana versioned tx for an x402 `exact`-scheme payment via ika MPC.
 * Returns the wire-ready PaymentPayload and pre-encoded PAYMENT-SIGNATURE header value.
 */
export async function buildAndSignX402Solana(args: SolanaSignArgs): Promise<SolanaSignResult> {
  const ownerPubkey = new PublicKey(await getSolanaAddress());
  const built = await buildX402VersionedTx({
    requirements: args.requirements,
    owner: ownerPubkey,
  });

  // sign the message bytes with the dWallet ed25519 path (ika MPC). same primitive every other
  // chromatika Solana flow uses, so the address dapps see is the one paying.
  const dwalletId = args.ed25519DwalletId;
  const dwalletPubkeyBytes = dwalletId
    ? await getDwalletEd25519PublicKeyForDwalletId(dwalletId)
    : await getDwalletEd25519PublicKey();
  if (!ownerPubkey.equals(new PublicKey(dwalletPubkeyBytes))) {
    throw new Error(
      'active dWallet ed25519 pubkey does not match active Solana address - signer would produce a tx for a different account',
    );
  }
  const { signature: sigHex } = await signMessageSol(
    built.messageBytes,
    dwalletId ? { ed25519DwalletId: dwalletId } : undefined,
  );
  const sigCleanHex = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
  if (sigCleanHex.length !== 128) {
    throw new Error('unexpected signature length from ika; expected 64-byte ed25519 sig');
  }
  const sigBytes = Uint8Array.from(sigCleanHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  if (!ed25519.verify(sigBytes, built.messageBytes, dwalletPubkeyBytes)) {
    throw new Error(
      'ika ed25519 output failed Solana verification on x402 tx message - hash/scheme mismatch vs chain',
    );
  }
  built.vtx.addSignature(ownerPubkey, sigBytes);

  // partial-sign serialize: keep the feePayer slot empty so the facilitator can fill its own
  // signature at submit time. web3.js' VersionedTransaction.serialize() includes empty
  // signatures as 64-byte zero arrays which is the wire form facilitators expect.
  const wire = built.vtx.serialize();
  const transactionBase64 = bufferToBase64(wire);

  const inner: SolanaExactPayload = { transaction: transactionBase64 };
  const paymentPayload: PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: 'exact',
    network: args.requirements.network,
    payload: inner,
  };
  const headerValue = encodeBase64Json(paymentPayload);

  return {
    paymentPayload,
    headerValue,
    headerName: X402_HEADER_PAYMENT_SIGNATURE,
    memoText: built.memoText,
    sourceAta: built.sourceAta,
    destAta: built.destAta,
    feePayer: built.feePayerStr,
  };
}

/** Re-export a small helper for the dispatcher slice (decode + sanity-check before signing). */
export function decodeBase58Pubkey(b58: string): PublicKey {
  // wraps `new PublicKey(...)` with a clearer error since base58 errors from web3.js are terse.
  try {
    const bytes = base58.decode(b58);
    if (bytes.length !== 32) {
      throw new Error(`expected 32-byte pubkey, got ${bytes.length}`);
    }
    return new PublicKey(b58);
  } catch (e) {
    throw new Error(`invalid Solana pubkey '${b58}': ${e instanceof Error ? e.message : String(e)}`);
  }
}
