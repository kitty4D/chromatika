/**
 * ika pre-alpha dWallet gRPC (grpc-web) for ika Solana base chain.
 * uses `@ika.xyz/pre-alpha-solana-client` BCS layouts + protobuf-ts grpc-web transport.
 *
 * wire schema (>= 0.1.1) per skills/ika-solana-prealpha/references/grpc-api.md:
 *   - DKG: `user_secret_key_share: UserSecretKeyShare::Encrypted { ... }` + nullable
 *     `sign_during_dkg_request`. response attestation decodes as
 *     `VersionedDWalletDataAttestation::V1` and dWallet identity is the PDA of
 *     (curve_u16_le || public_key), not a field inside the attestation.
 *   - Presign / Sign: curve and hash_scheme are NOT on the wire. `Sign` carries
 *     `message_metadata`, `presign_session_identifier`, `dwallet_attestation`.
 *     `PresignForDWallet` carries `dwallet_public_key` + `dwallet_attestation`.
 *   - Presign response returns through `Attestation` -> `VersionedPresignDataAttestation::V1`
 *     (no separate `Presign` response variant).
 */

import { sign } from '@noble/ed25519';
import { defineBcsTypes } from '@ika.xyz/pre-alpha-solana-client/grpc-web';
import { GrpcWebFetchTransport } from '@protobuf-ts/grpcweb-transport';
import { DWalletServiceClient } from '@ika-pre-alpha/dwallet-grpc-web-client';
import { Keypair, PublicKey } from '@solana/web3.js';
import { base58 } from '@scure/base';

export const SOLANA_PREALPHA_GRPC_URL = 'https://pre-alpha-dev-1.ika.ika-network.net:443';
export const SOLANA_PREALPHA_PROGRAM_ID = '87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY';

const bcs = defineBcsTypes();
const PROGRAM = new PublicKey(SOLANA_PREALPHA_PROGRAM_ID);

export type SolanaDkgCurve = 'Secp256k1' | 'Curve25519';

export type SolanaPresignSigAlg = 'ECDSASecp256k1' | 'Taproot' | 'EdDSA';

/** `DWalletCurve` u16 discriminant (BCS enum order: Secp256k1=0, Secp256r1=1, Curve25519=2, Ristretto=3). */
function curveU16(curve: SolanaDkgCurve): number {
  return curve === 'Secp256k1' ? 0 : 2;
}

/**
 * DWallet PDA seeds: `["dwallet", ...chunks_of_32(curve_u16_le || public_key)]`.
 * pubkey sizes: 32 (Curve25519), 33 compressed Secp, 65 uncompressed Secp.
 * post-0.1.1 the dWallet identity is this PDA, not a field on the attestation.
 */
export function deriveSolanaDWalletPda(curve: SolanaDkgCurve, publicKey: Uint8Array): PublicKey {
  const payload = new Uint8Array(2 + publicKey.length);
  payload[0] = curveU16(curve) & 0xff;
  payload[1] = (curveU16(curve) >> 8) & 0xff;
  payload.set(publicKey, 2);
  const seeds: Buffer[] = [Buffer.from('dwallet')];
  for (let i = 0; i < payload.length; i += 32) {
    seeds.push(Buffer.from(payload.subarray(i, Math.min(i + 32, payload.length))));
  }
  const [pda] = PublicKey.findProgramAddressSync(seeds, PROGRAM);
  return pda;
}

/** parsed `NetworkSignedAttestation` - matches BCS layout field-for-field so we can re-serialize verbatim. */
export type SolanaNetworkSignedAttestation = {
  attestation_data: number[];
  network_signature: number[];
  network_pubkey: number[];
  epoch: bigint;
};

function toNsa(input: { attestation_data: number[] | Uint8Array; network_signature: number[] | Uint8Array; network_pubkey: number[] | Uint8Array; epoch: bigint | string | number }): SolanaNetworkSignedAttestation {
  return {
    attestation_data: Array.from(input.attestation_data),
    network_signature: Array.from(input.network_signature),
    network_pubkey: Array.from(input.network_pubkey),
    epoch: typeof input.epoch === 'bigint' ? input.epoch : BigInt(input.epoch),
  };
}

/** fee identity + ED25519 sign over raw `SignedRequestData` bytes (local key or Ledger offchain popup). */
export type SolanaGrpcFeeMaterial = {
  publicKey: PublicKey;
  signEd25519Payload: (payload: Uint8Array) => Promise<Uint8Array>;
};

function publicKeyToFeeBytes(pk: PublicKey): Uint8Array {
  if (typeof pk.toBytes === 'function') return pk.toBytes();
  return new Uint8Array(pk.toBuffer());
}

export function solanaGrpcFeeFromKeypair(keypair: Keypair): SolanaGrpcFeeMaterial {
  return {
    publicKey: keypair.publicKey,
    signEd25519Payload: async (payload) => {
      const sk = keypair.secretKey.slice(0, 32);
      return sign(payload, sk);
    },
  };
}

function hex0x(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function b64Encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64Decode(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** reconstruct the `NetworkSignedAttestation` struct from the stored b64 bytes. */
function nsaFromB64(b64: string): SolanaNetworkSignedAttestation {
  const bytes = b64Decode(b64);
  const parsed = bcs.NetworkSignedAttestation.parse(bytes) as {
    attestation_data: number[];
    network_signature: number[];
    network_pubkey: number[];
    epoch: string | bigint;
  };
  return toNsa(parsed);
}

/**
 * submits BCS `SignedRequestData` to ika `SubmitTransaction`, with ED25519 user signature over the payload.
 */
export class SolanaIkaGrpcClient {
  private readonly client: DWalletServiceClient;

  constructor(
    readonly endpoint: string,
    private readonly fee: SolanaGrpcFeeMaterial,
  ) {
    const baseUrl = endpoint.replace(/\/$/, '');
    const transport = new GrpcWebFetchTransport({ baseUrl });
    this.client = new DWalletServiceClient(transport);
  }

  private async userSignatureBytes(signedRequestData: Uint8Array): Promise<Uint8Array> {
    const sig = await this.fee.signEd25519Payload(signedRequestData);
    return bcs.UserSignature.serialize({
      Ed25519: {
        signature: Array.from(sig),
        public_key: Array.from(publicKeyToFeeBytes(this.fee.publicKey)),
      },
    }).toBytes();
  }

  async submitSignedRequestData(signedRequestData: Uint8Array): Promise<Uint8Array> {
    const userSig = await this.userSignatureBytes(signedRequestData);
    const { response } = await this.client.submitTransaction({
      userSignature: userSig,
      signedRequestData: signedRequestData,
    });
    return response.responseData;
  }

  /**
   * pre-alpha mock DKG. returns:
   * - `dwalletAddrB58`: PDA derived from `(curve, public_key)` per account-layouts.md
   * - `dwalletPublicKeyB64`: raw public_key bytes (needed for Presign + Sign)
   * - `dwalletAttestationBytesB64`: BCS `NetworkSignedAttestation` bytes (replay verbatim into
   *   every subsequent Presign / Sign request on this dWallet)
   */
  async requestDKG(curve: SolanaDkgCurve): Promise<{
    dwalletAddrB58: string;
    dwalletPublicKeyB64: string;
    dwalletAttestationBytesB64: string;
  }> {
    const senderPubkey = publicKeyToFeeBytes(this.fee.publicKey);
    const curveEnum = curve === 'Secp256k1' ? { Secp256k1: true } : { Curve25519: true };
    const data = bcs.SignedRequestData.serialize({
      session_identifier_preimage: Array.from(crypto.getRandomValues(new Uint8Array(32))),
      epoch: 1n,
      chain_id: { Solana: true },
      intended_chain_sender: Array.from(senderPubkey),
      request: {
        DKG: {
          dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
          curve: curveEnum,
          centralized_public_key_share_and_proof: Array.from(new Uint8Array(32)),
          user_secret_key_share: {
            Encrypted: {
              encrypted_centralized_secret_share_and_proof: Array.from(new Uint8Array(32)),
              encryption_key: Array.from(new Uint8Array(32)),
              signer_public_key: Array.from(senderPubkey),
            },
          },
          user_public_output: Array.from(new Uint8Array(32)),
          sign_during_dkg_request: null,
        },
      },
    }).toBytes();

    const respBytes = await this.submitSignedRequestData(new Uint8Array(data));
    const resp = bcs.TransactionResponseData.parse(new Uint8Array(respBytes)) as {
      Attestation?: {
        attestation_data: number[];
        network_signature: number[];
        network_pubkey: number[];
        epoch: string | bigint;
      };
      Error?: { message: string };
    };
    if (resp.Error) throw new Error(`DKG failed: ${resp.Error.message}`);
    if (!resp.Attestation) throw new Error(`DKG failed: ${JSON.stringify(resp)}`);

    const nsa = toNsa(resp.Attestation);
    const attestationBytes = bcs.NetworkSignedAttestation.serialize(nsa).toBytes();

    const versioned = bcs.VersionedDWalletDataAttestation.parse(
      new Uint8Array(resp.Attestation.attestation_data),
    ) as { V1?: { public_key: number[] } };
    if (!versioned.V1) {
      throw new Error(`DKG attestation missing V1 variant: ${JSON.stringify(versioned)}`);
    }
    const publicKey = new Uint8Array(versioned.V1.public_key);
    const pda = deriveSolanaDWalletPda(curve, publicKey);

    return {
      dwalletAddrB58: pda.toBase58(),
      dwalletPublicKeyB64: b64Encode(publicKey),
      dwalletAttestationBytesB64: b64Encode(attestationBytes),
    };
  }

  /**
   * global presign bound to a specific dWallet. caller must supply the dWallet's public key and
   * the `NetworkSignedAttestation` bytes captured at DKG (both live on `DWalletMeta`).
   */
  async requestPresignForDWallet(
    dwalletIdB58: string,
    curve: SolanaDkgCurve,
    sigAlg: SolanaPresignSigAlg,
    args: { dwalletPublicKeyB64: string; dwalletAttestationBytesB64: string },
  ): Promise<{ presignIdHex: string }> {
    const dwalletBytes = base58.decode(dwalletIdB58);
    const dwalletPubkey = b64Decode(args.dwalletPublicKeyB64);
    const nsa = nsaFromB64(args.dwalletAttestationBytesB64);
    const curveEnum = curve === 'Secp256k1' ? { Secp256k1: true } : { Curve25519: true };
    const sigEnum =
      sigAlg === 'ECDSASecp256k1'
        ? { ECDSASecp256k1: true }
        : sigAlg === 'Taproot'
          ? { Taproot: true }
          : { EdDSA: true };

    const data = bcs.SignedRequestData.serialize({
      session_identifier_preimage: Array.from(dwalletBytes.slice(0, 32)),
      epoch: 1n,
      chain_id: { Solana: true },
      intended_chain_sender: Array.from(publicKeyToFeeBytes(this.fee.publicKey)),
      request: {
        PresignForDWallet: {
          dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
          dwallet_public_key: Array.from(dwalletPubkey),
          dwallet_attestation: nsa,
          curve: curveEnum,
          signature_algorithm: sigEnum,
        },
      },
    }).toBytes();

    const respBytes = await this.submitSignedRequestData(new Uint8Array(data));
    const resp = bcs.TransactionResponseData.parse(new Uint8Array(respBytes)) as {
      Attestation?: { attestation_data: number[] };
      Error?: { message: string };
    };
    if (resp.Error) throw new Error(`Presign failed: ${resp.Error.message}`);
    if (!resp.Attestation) throw new Error(`Presign failed: ${JSON.stringify(resp)}`);

    const versioned = bcs.VersionedPresignDataAttestation.parse(
      new Uint8Array(resp.Attestation.attestation_data),
    ) as { V1?: { presign_session_identifier: number[] } };
    if (!versioned.V1) {
      throw new Error(`Presign attestation missing V1 variant: ${JSON.stringify(versioned)}`);
    }
    return { presignIdHex: hex0x(new Uint8Array(versioned.V1.presign_session_identifier)) };
  }

  /**
   * global presign (NOT bound to a specific dWallet). required for every Sign call regardless of
   * curve, per upstream `protocols-e2e/main.rs` (DKG -> Presign -> Sign for all 7 schemes including
   * EdDSA+SHA512 on Curve25519). this is the `DWalletRequest::Presign` variant - distinct from
   * `PresignForDWallet`, which the mock signer gates to imported ECDSA only and rejects for
   * Curve25519 / EdDSA with "PresignForDWallet is only for imported ECDSA keys".
   *
   * for deterministic schemes (ED25519 per RFC 8032) the presign is cryptographically a no-op,
   * but the validator still requires the session identifier to bind Sign to a Presign attestation
   * - skipping it surfaces as "no key for dwallet ... or scheme X incompatible with curve Y" on
   * the next Sign, which looks like a wiped dWallet but is actually missing protocol state.
   */
  async requestPresign(
    curve: SolanaDkgCurve,
    sigAlg: SolanaPresignSigAlg,
  ): Promise<{ presignIdHex: string }> {
    const curveEnum = curve === 'Secp256k1' ? { Secp256k1: true } : { Curve25519: true };
    const sigEnum =
      sigAlg === 'ECDSASecp256k1'
        ? { ECDSASecp256k1: true }
        : sigAlg === 'Taproot'
          ? { Taproot: true }
          : { EdDSA: true };

    const data = bcs.SignedRequestData.serialize({
      session_identifier_preimage: Array.from(crypto.getRandomValues(new Uint8Array(32))),
      epoch: 1n,
      chain_id: { Solana: true },
      intended_chain_sender: Array.from(publicKeyToFeeBytes(this.fee.publicKey)),
      request: {
        Presign: {
          dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
          curve: curveEnum,
          signature_algorithm: sigEnum,
        },
      },
    }).toBytes();

    const respBytes = await this.submitSignedRequestData(new Uint8Array(data));
    const resp = bcs.TransactionResponseData.parse(new Uint8Array(respBytes)) as {
      Attestation?: { attestation_data: number[] };
      Error?: { message: string };
    };
    if (resp.Error) throw new Error(`Presign failed: ${resp.Error.message}`);
    if (!resp.Attestation) throw new Error(`Presign failed: ${JSON.stringify(resp)}`);

    const versioned = bcs.VersionedPresignDataAttestation.parse(
      new Uint8Array(resp.Attestation.attestation_data),
    ) as { V1?: { presign_session_identifier: number[] } };
    if (!versioned.V1) {
      throw new Error(`Presign attestation missing V1 variant: ${JSON.stringify(versioned)}`);
    }
    return { presignIdHex: hex0x(new Uint8Array(versioned.V1.presign_session_identifier)) };
  }

  /**
   * ED25519 / Curve25519 message sign. the scheme is *not* on the wire - validators derive
   * `DWalletSignatureScheme` from the on-chain `MessageApproval` + `dwallet_attestation`.
   */
  async requestSignEd25519Message(
    message: Uint8Array,
    dwalletIdB58: string,
    presignId: Uint8Array,
    approveTxSignatureBytes: Uint8Array,
    slot: bigint,
    args: { dwalletAttestationBytesB64: string },
  ): Promise<Uint8Array> {
    return this.requestSign(message, dwalletIdB58, presignId, approveTxSignatureBytes, slot, args);
  }

  /**
   * Secp256k1 ECDSA message sign. hash scheme is encoded in the on-chain `MessageApproval`
   * (set by `sendApproveMessageForSign` -> `DWalletSignatureScheme`), not in the gRPC request.
   */
  async requestSignSecp256k1Message(
    message: Uint8Array,
    dwalletIdB58: string,
    presignId: Uint8Array,
    approveTxSignatureBytes: Uint8Array,
    slot: bigint,
    args: { dwalletAttestationBytesB64: string },
  ): Promise<Uint8Array> {
    return this.requestSign(message, dwalletIdB58, presignId, approveTxSignatureBytes, slot, args);
  }

  private async requestSign(
    message: Uint8Array,
    dwalletIdB58: string,
    presignId: Uint8Array,
    approveTxSignatureBytes: Uint8Array,
    slot: bigint,
    args: { dwalletAttestationBytesB64: string },
  ): Promise<Uint8Array> {
    const dwalletBytes = base58.decode(dwalletIdB58);
    const nsa = nsaFromB64(args.dwalletAttestationBytesB64);
    const data = bcs.SignedRequestData.serialize({
      session_identifier_preimage: Array.from(dwalletBytes.slice(0, 32)),
      epoch: 1n,
      chain_id: { Solana: true },
      intended_chain_sender: Array.from(publicKeyToFeeBytes(this.fee.publicKey)),
      request: {
        Sign: {
          message: Array.from(message),
          message_metadata: [],
          presign_session_identifier: Array.from(presignId),
          message_centralized_signature: Array.from(new Uint8Array(64)),
          dwallet_attestation: nsa,
          approval_proof: {
            Solana: { transaction_signature: Array.from(approveTxSignatureBytes), slot },
          },
        },
      },
    }).toBytes();

    const respBytes = await this.submitSignedRequestData(new Uint8Array(data));
    const resp = bcs.TransactionResponseData.parse(new Uint8Array(respBytes)) as {
      Signature?: { signature: number[] };
      Error?: { message: string };
    };
    if (resp.Signature) return new Uint8Array(resp.Signature.signature);
    if (resp.Error) throw new Error(resp.Error.message);
    throw new Error(`Unexpected Sign response: ${JSON.stringify(resp)}`);
  }

  async getPresignsFromNetwork(): Promise<string[]> {
    const { response } = await this.client.getPresigns({ userPubkey: publicKeyToFeeBytes(this.fee.publicKey) });
    return (response.presigns ?? []).map((p) => hex0x(new Uint8Array(p.presignId)));
  }
}
