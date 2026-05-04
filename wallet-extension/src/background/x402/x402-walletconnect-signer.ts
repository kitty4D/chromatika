/**
 * x402 Solana exact-scheme signer: **WalletConnect path**.
 *
 * used when `session.solanaWcAccount` is set: the user has paired a phone wallet (Seeker /
 * Phantom / Solflare / any WC-v2-Solana-namespace wallet) over WalletConnect. the phone IS
 * the signer for x402 payments: ika MPC is bypassed entirely. the address that holds USDC
 * and pays = the WC-paired address (the same one the wallet exposes for chain ops).
 *
 * trust model wins:
 *   - the ed25519 keypair never leaves the phone's secure element (Seed Vault on Seeker).
 *   - chromatika's compromise surface cannot drain the user without a phone tap per payment.
 *   - the 402bridge breach class is fully mitigated (the breach was "agent had key in-process").
 *
 * UX cost:
 *   - every x402 popup -> an additional hardware-sign popup -> a phone tap. ~2-5s extra latency
 *     per payment. acceptable for amounts above the chain economic floor.
 *
 * sibling of `x402-solana-signer.ts` (ika MPC); both consume `x402-solana-build.ts` for the
 * unsigned tx assembly. only the signing primitive differs.
 */

import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { enqueueHardwareSign } from '@/background/hardware/pending-queue';
import { getSession } from '@/background/session';
import {
  X402_HEADER_PAYMENT_SIGNATURE,
  X402_VERSION,
  encodeBase64Json,
  type PaymentPayload,
  type PaymentRequirements,
  type SolanaExactPayload,
} from './x402-types';
import { buildX402VersionedTx, bufferToBase64 } from './x402-solana-build';

export type WcSolanaSignResult = {
  paymentPayload: PaymentPayload;
  headerValue: string;
  headerName: typeof X402_HEADER_PAYMENT_SIGNATURE;
  memoText: string;
  sourceAta: string;
  destAta: string;
  feePayer: string;
};

export type WcSolanaSignArgs = {
  requirements: PaymentRequirements;
};

function uint8ToHexNo0x(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function hexNo0xToUint8(hex: string): Uint8Array {
  const t = hex.replace(/^0x/i, '');
  if (t.length % 2 !== 0) throw new Error('hex length must be even');
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Build + WC-sign + partial-sign-serialize the x402 versioned tx. Throws if no
 * `solanaWcAccount` is present on the session - the dispatcher should pre-check before calling.
 *
 * Flow:
 *   1. shared builder produces the unsigned VersionedTransaction with feePayer = facilitator,
 *      one SPL transfer (owner = WC-paired address), one Memo v2.
 *   2. enqueue a hardware-sign with `vendor: 'walletconnect', kind: 'solanaTx'`. The popup at
 *      `?hwsign=<id>` opens, mounts `WalletConnectSigner`, sends `solana_signTransaction` over
 *      the relay; phone wallet deserializes, prompts the user, signs, returns the sig.
 *   3. attach the sig to the owner slot, leave feePayer slot empty for the facilitator.
 */
export async function buildAndSignX402SolanaViaWalletConnect(args: WcSolanaSignArgs): Promise<WcSolanaSignResult> {
  const session = getSession();
  if (!session) throw new Error('Wallet locked');
  const wc = session.solanaWcAccount;
  if (!wc) {
    throw new Error(
      'WalletConnect Solana account not paired - run the WalletConnect pairing from settings → hardware first',
    );
  }

  const ownerPubkey = new PublicKey(wc.address);
  const built = await buildX402VersionedTx({
    requirements: args.requirements,
    owner: ownerPubkey,
  });

  // serialize the unsigned tx for the WC popup. WalletConnectSigner expects payloadHex to be
  // the hex of the full VersionedTransaction wire bytes (with empty signature slots); it
  // base58-encodes for `solana_signTransaction` and the wallet returns either a signature
  // alone or the signed tx. our handler resolves to a hex sig either way.
  const unsignedWire = built.vtx.serialize();
  const payloadHex = uint8ToHexNo0x(unsignedWire);

  const sigHex = await enqueueHardwareSign({
    vendor: 'walletconnect',
    chain: 'solana',
    derivationPath: 'wc:solana',
    payloadHex,
    kind: 'solanaTx',
    wcSessionTopic: wc.sessionTopic,
    wcChainId: wc.chainId,
    wcAccountAddress: wc.address,
    // x402 settlement is mainnet-only by spec (X402_SOLANA_MAINNET_CAIP2); surface
    // `mainnet` on the sign popup so the user sees the cluster they're paying on.
    solanaCluster: 'mainnet',
  });

  const sigBytes = hexNo0xToUint8(sigHex);
  if (sigBytes.length !== 64) {
    throw new Error(`unexpected ed25519 signature length from WalletConnect: ${sigBytes.length}`);
  }

  // Re-deserialize the same unsigned wire and add the signature. (We could also just call
  // built.vtx.addSignature(ownerPubkey, sigBytes), but constructing fresh from the wire we
  // sent to the popup keeps any divergent state from leaking - the popup signed exactly
  // these bytes and only these bytes.)
  const vtx = VersionedTransaction.deserialize(unsignedWire);
  vtx.addSignature(ownerPubkey, sigBytes);

  // partial-sign serialize: feePayer slot stays empty for the facilitator.
  const signedWire = vtx.serialize();
  const transactionBase64 = bufferToBase64(signedWire);

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
