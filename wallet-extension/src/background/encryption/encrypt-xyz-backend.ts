/**
 * EncryptXyzBackend - the default `EncryptionBackend` implementation for self-recipient cases.
 * wraps a random 256-bit AES key K via 2× EUint128 chunks through encrypt.xyz `CreateInput`, then
 * encrypts the body via AES-GCM under K. the body ciphertext is returned to the caller for
 * whichever persistence layer fits the use case (chrome.storage for activity notes, walrus for
 * vault backup, solana account for x402 receipts).
 *
 * self-recipient only. encrypt.xyz pre-alpha has no `recipient_pubkey` field on `CreateInput`
 * (the `authorized` field is program-access control, not encryption recipient), and
 * `ReadCiphertext` returns plaintext to the signer's pubkey only. cross-recipient calls throw
 * `EncryptionBackendError('unsupported-recipient')` - those use cases route to
 * `DirectEd25519Backend`. see `wallet-extension/docs/ENCRYPTION_BACKEND.md`.
 *
 * decrypt asserts the active vault's dWallet ed25519 pubkey still matches `payload.recipientPubkeyB64`
 * before triggering an ika sign. without that guard, switching vaults and clicking "decrypt"
 * would produce a confusing downstream `signMessageSol` failure rather than a clean
 * `wrong-vault` error.
 */

import { PublicKey } from '@solana/web3.js';
import {
  type EncryptedRef,
  type EncryptionBackend,
  type EncryptionBackendCapabilities,
  EncryptionBackendError,
  type EncryptXyzPayload,
  type RecipientId,
} from '@/background/encryption/types';
import { importMasterKeyBytes } from '@/background/vault';
import { signMessageSol } from '@/background/chains/signing';
import { getDwalletEd25519PublicKey } from '@/background/chains/solana';
import { ENCRYPT_SOLANA_GRPC_URL, ENCRYPT_SOLANA_PROGRAM_ID } from '@/background/encrypt/encrypt-constants';
import {
  encodeCreateInputRequest,
  decodeCreateInputResponse,
  encodeReadCiphertextRequest,
  decodeReadCiphertextResponse,
} from '@/background/encrypt/encrypt-protobuf-wire';
import { encodeReadCiphertextMessage } from '@/background/encrypt/encrypt-read-msg';
import { encryptGrpcCreateInput, encryptGrpcReadCiphertext } from '@/background/encrypt/encrypt-grpc-web-fetch';
import { encryptValue } from '@encrypt.xyz/pre-alpha-solana-client/grpc-web';
import {
  bytesLeToBigInt,
  FHE_TYPE_EUINT128,
  hex,
  hexToBytes,
  labConnection,
  resolveNetworkEncryptionPublicKey,
  signatureHexToEd25519Bytes,
} from '@/background/encrypt/encrypt-lab-service';

const GRPC_BASE = ENCRYPT_SOLANA_GRPC_URL.replace(/\/$/, '');
const ENCRYPT_XYZ_CHAIN = 0; // solana devnet - encrypt.xyz `chain` field

const AES_GCM_IV_BYTES = 12;
const AES_KEY_BYTES = 32;
const K_CHUNK_BYTES = 16; // EUint128 = 16 bytes per ciphertext

/** caller-side cap. notes use cases stay well under 8KB. larger payloads should add walrus body storage. */
const MAX_INLINE_PLAINTEXT_BYTES = 8 * 1024;

const CAPABILITIES: EncryptionBackendCapabilities = Object.freeze({
  supportsCrossRecipient: false,
  supportsThresholdAccess: false,
  supportsInlineBody: true,
  maxInlinePlaintextBytes: MAX_INLINE_PLAINTEXT_BYTES,
});

function toBase64(buf: Uint8Array): string {
  // btoa works on latin-1 byte strings; fromCharCode of each byte is safe up to ~32KB on the
  // call-stack-arg-count budget for any modern JS engine. activity notes max at 8KB so this is fine.
  return btoa(String.fromCharCode(...buf));
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function toUint8(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

async function activeDwalletEd25519PubkeyB64(): Promise<string> {
  const pk = await getDwalletEd25519PublicKey();
  return toBase64(pk);
}

/**
 * wrap a 32-byte K via encrypt.xyz `CreateInput`, batched as 2 EUint128 inputs in a single gRPC
 * round-trip. returns the 2 ciphertext_identifier hexes in chunk order (chunk0 wraps K[0..16],
 * chunk1 wraps K[16..32]).
 */
async function wrapKWithEncryptXyz(K: Uint8Array): Promise<{ wrappedKeyHexes: [string, string] }> {
  if (K.length !== AES_KEY_BYTES) {
    throw new EncryptionBackendError('encrypt-xyz', 'protocol-error', `K must be ${AES_KEY_BYTES} bytes, got ${K.length}`);
  }
  const connection = labConnection();
  const programId = new PublicKey(ENCRYPT_SOLANA_PROGRAM_ID);
  const networkPk = await resolveNetworkEncryptionPublicKey(connection, programId);
  const chunk0 = K.subarray(0, K_CHUNK_BYTES);
  const chunk1 = K.subarray(K_CHUNK_BYTES, AES_KEY_BYTES);
  const req = encodeCreateInputRequest({
    chain: ENCRYPT_XYZ_CHAIN,
    inputs: [
      { ciphertextBytes: encryptValue(bytesLeToBigInt(chunk0), FHE_TYPE_EUINT128), fheType: FHE_TYPE_EUINT128 },
      { ciphertextBytes: encryptValue(bytesLeToBigInt(chunk1), FHE_TYPE_EUINT128), fheType: FHE_TYPE_EUINT128 },
    ],
    proof: new Uint8Array(0),
    authorized: new Uint8Array(programId.toBytes()),
    networkEncryptionPublicKey: networkPk,
  });
  const resBytes = await encryptGrpcCreateInput(GRPC_BASE, req);
  const parsed = decodeCreateInputResponse(resBytes);
  if (parsed.ciphertextIdentifiers.length !== 2) {
    throw new EncryptionBackendError(
      'encrypt-xyz',
      'protocol-error',
      `CreateInput returned ${parsed.ciphertextIdentifiers.length} ids; expected 2`,
    );
  }
  return {
    wrappedKeyHexes: [hex(parsed.ciphertextIdentifiers[0]!), hex(parsed.ciphertextIdentifiers[1]!)],
  };
}

/**
 * unwrap K by reading both ciphertext chunks via encrypt.xyz `ReadCiphertext`. each read is a
 * `signMessageSol` round-trip plus a gRPC call. we do them sequentially because ika MPC signing
 * doesn't parallelize cleanly across two presigns - the in-flight queue is per-curve, and
 * stacking two ReadCiphertext signs would just thrash the presign refill. ~1-3 seconds total
 * on devnet.
 */
async function unwrapKWithEncryptXyz(wrappedKeyHexes: [string, string]): Promise<Uint8Array> {
  const signerPk = await getDwalletEd25519PublicKey();
  const out = new Uint8Array(AES_KEY_BYTES);
  for (let i = 0; i < 2; i++) {
    const idHex = wrappedKeyHexes[i]!;
    const ct = hexToBytes(idHex);
    const msg = encodeReadCiphertextMessage(ENCRYPT_XYZ_CHAIN, ct, new Uint8Array(0), 0n);
    const { signature } = await signMessageSol(msg);
    const sigBytes = signatureHexToEd25519Bytes(signature);
    const req = encodeReadCiphertextRequest({ message: msg, signature: sigBytes, signer: signerPk });
    let resBytes: Uint8Array;
    try {
      resBytes = await encryptGrpcReadCiphertext(GRPC_BASE, req);
    } catch (e) {
      const msgText = e instanceof Error ? e.message : String(e);
      // devnet wipes rotate ciphertext accounts; the executor returns "ciphertext not found" or
      // similar. translate to a stable error code so callers can render the "encrypted note from
      // a previous devnet generation" UX without string-matching the underlying error.
      if (/not.found|missing|unknown.identifier/i.test(msgText)) {
        throw new EncryptionBackendError(
          'encrypt-xyz',
          'devnet-wipe',
          `wrapped key chunk ${i} no longer exists on devnet (likely cleared by a wipe). The encrypted payload cannot be recovered. Original error: ${msgText}`,
        );
      }
      throw new EncryptionBackendError('encrypt-xyz', 'protocol-error', `ReadCiphertext failed for chunk ${i}: ${msgText}`);
    }
    const parsed = decodeReadCiphertextResponse(resBytes);
    if (parsed.value.length < K_CHUNK_BYTES) {
      throw new EncryptionBackendError(
        'encrypt-xyz',
        'protocol-error',
        `ReadCiphertext returned ${parsed.value.length} bytes for chunk ${i}; expected ${K_CHUNK_BYTES}`,
      );
    }
    out.set(parsed.value.subarray(0, K_CHUNK_BYTES), i * K_CHUNK_BYTES);
  }
  return out;
}

export const encryptXyzBackend: EncryptionBackend = {
  id: 'encrypt-xyz',
  capabilities: CAPABILITIES,

  async encryptForRecipient(plaintext: Uint8Array, recipient: RecipientId): Promise<EncryptedRef> {
    if (recipient.kind !== 'self') {
      throw new EncryptionBackendError(
        'encrypt-xyz',
        'unsupported-recipient',
        `encrypt.xyz pre-alpha cannot encrypt to ${recipient.kind} recipients - CreateInput has no recipient_pubkey field today. Use DirectEd25519Backend for cross-recipient envelopes. See wallet-extension/docs/ENCRYPTION_BACKEND.md.`,
      );
    }
    if (plaintext.length > MAX_INLINE_PLAINTEXT_BYTES) {
      throw new EncryptionBackendError(
        'encrypt-xyz',
        'protocol-error',
        `plaintext ${plaintext.length} bytes exceeds inline cap ${MAX_INLINE_PLAINTEXT_BYTES}. Use a walrus-backed body for larger payloads.`,
      );
    }

    // generate K + body iv + AES-GCM body in one shot.
    const K = crypto.getRandomValues(new Uint8Array(AES_KEY_BYTES));
    const bodyIv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
    const aesKey = await importMasterKeyBytes(K);
    const bodyCt = toUint8(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bodyIv as BufferSource }, aesKey, plaintext as BufferSource),
    );

    // wrap K via encrypt.xyz CreateInput batch (single gRPC round-trip for both 16-byte chunks).
    const { wrappedKeyHexes } = await wrapKWithEncryptXyz(K);
    // K stays in JS heap until GC; we can't `K.fill(0)` because the AES-GCM CryptoKey holds a
    // reference. live with this until walrus-body / out-of-process key holding lands.

    const recipientPubkeyB64 = await activeDwalletEd25519PubkeyB64();
    const payload: EncryptXyzPayload = {
      wrappedKeyCiphertextIdHexes: wrappedKeyHexes,
      bodyCiphertextB64: toBase64(bodyCt),
      bodyIvB64: toBase64(bodyIv),
      recipientPubkeyB64,
      chain: ENCRYPT_XYZ_CHAIN,
      programId: ENCRYPT_SOLANA_PROGRAM_ID,
    };
    return { backend: 'encrypt-xyz', payload, createdAtMs: Date.now() };
  },

  async decrypt(ref: EncryptedRef): Promise<Uint8Array> {
    if (ref.backend !== 'encrypt-xyz') {
      throw new EncryptionBackendError('encrypt-xyz', 'protocol-error', `decrypt called with ${ref.backend} ref`);
    }
    const { payload } = ref;

    // active vault must still match the recipient stored on the ref. switching vaults between
    // encrypt and decrypt would otherwise call signMessageSol on a different ed25519 key and
    // get a confusing downstream error from the executor.
    const activeRecipientB64 = await activeDwalletEd25519PubkeyB64();
    if (activeRecipientB64 !== payload.recipientPubkeyB64) {
      throw new EncryptionBackendError(
        'encrypt-xyz',
        'wrong-vault',
        'this encrypted payload was created by a different vault on this install. switch vaults to decrypt.',
      );
    }

    const K = await unwrapKWithEncryptXyz(payload.wrappedKeyCiphertextIdHexes);
    const aesKey = await importMasterKeyBytes(K);
    const iv = fromBase64(payload.bodyIvB64);
    const bodyCt = fromBase64(payload.bodyCiphertextB64);
    const plain = toUint8(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, aesKey, bodyCt as BufferSource),
    );
    return plain;
  },
};
