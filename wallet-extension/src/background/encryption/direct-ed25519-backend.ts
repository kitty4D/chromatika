/**
 * DirectEd25519Backend: cross-recipient envelope via X25519 ECDH + HKDF + AES-GCM.
 *
 * per `docs/ENCRYPTION_BACKEND.md` option-b: each user has an HD-derived X25519 inbox
 * keypair (separate from the dWallet ed25519 identity, decoupled from MPC), used only for
 * cross-recipient decrypt. senders pass the recipient's X25519 inbox pubkey to
 * `encryptForRecipient`; the backend produces an envelope that only the holder of the
 * matching X25519 secret can decrypt.
 *
 * wire format (`DirectEd25519Payload`):
 *   - sender generates ephemeral X25519 keypair (es, eP)
 *   - shared = x25519(es, recipientX25519Pubkey)
 *   - K = HKDF-SHA256(shared, info='chromatika.direct-ed25519.envelope.v1', length=32)
 *   - body = AES-GCM-256(K, plaintext, iv) -> ciphertext + tag (concat)
 *   - persisted ref:
 *       { ephemeralPubkeyB64, bodyCiphertextB64, bodyIvB64, recipientPubkeyB64 }
 *
 * the receiver:
 *   - resolves their X25519 inbox secret via the keyring helpers (`x25519InboxSecretFromBytes`)
 *   - shared = x25519(receiverSecret, ephemeralPubkey)
 *   - K = HKDF-SHA256(shared, info='chromatika.direct-ed25519.envelope.v1', length=32)
 *   - plaintext = AES-GCM-256.decrypt(K, ciphertext, iv)
 *
 * notes:
 *   - the `pubkey` field on `RecipientId { kind: 'ed25519' }` is interpreted as the
 *     recipient's X25519 inbox pubkey (32 bytes raw). despite the `'ed25519'` discriminator,
 *     the bytes are X25519-format; the kind label is preserved from the original interface
 *     design where ed25519 -> X25519 conversion was planned. v1 may rename the discriminator
 *     to `'x25519-inbox'` for clarity.
 *   - `decrypt` resolves the receiver's inbox secret from the active session. v0 supports
 *     the SECP/ED25519 dWallet vault's mnemonic-or-MWA-signature root; v1 will surface the
 *     inbox key explicitly via tRPC for self-encrypt round-trips.
 *   - AES key K is a 32-byte secret. sender + receiver compute the same K via ECDH, never
 *     transmit it.
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  type EncryptedRef,
  type EncryptionBackend,
  type EncryptionBackendCapabilities,
  EncryptionBackendError,
  type RecipientId,
} from '@/background/encryption/types';
import { getSession } from '@/background/session';
import { x25519InboxSecretFromBytes } from '@/background/keyring/hd';

const CAPABILITIES: EncryptionBackendCapabilities = Object.freeze({
  supportsCrossRecipient: true,
  supportsThresholdAccess: false,
  supportsInlineBody: true,
  /** same notes-style cap as EncryptXyzBackend; larger payloads should pair with walrus. */
  maxInlinePlaintextBytes: 8 * 1024,
});

const HKDF_INFO = new TextEncoder().encode('chromatika.direct-ed25519.envelope.v1');
const AES_KEY_LENGTH_BYTES = 32;
const AES_IV_LENGTH_BYTES = 12;

function b64Encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function b64Decode(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * resolve the active vault's X25519 inbox secret for decrypt. v0 supports vault kinds whose
 * `ikaSeedSource` we can reach through the session: hd (mnemonic), hardware (mwa signature),
 * and passkey (prf output). v1 will plumb an explicit `inboxSecret` field on the session.
 */
async function resolveActiveInboxSecret(): Promise<Uint8Array> {
  const s = getSession();
  if (!s?.activeVaultId) {
    throw new EncryptionBackendError(
      'direct-ed25519',
      'wrong-vault',
      'unlock the wallet to derive the X25519 inbox secret',
    );
  }
  // pull root secret bytes from session. the session stores `mnemonic` for hd vaults and
  // `seekerSignatureBytes` for hardware vaults. passkey vaults expose the prf output via the
  // session's keyring layer. for v0 we walk the same options the ika seed derivation used.
  // the session field shapes are documented in `src/background/session.ts`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sess = s as any;
  const mnemonic: string | undefined = sess.mnemonic;
  if (typeof mnemonic === 'string' && mnemonic.length > 0) {
    const { x25519InboxSecretFromRecoveryWords } = await import('@/background/keyring/hd');
    return x25519InboxSecretFromRecoveryWords(mnemonic, 0);
  }
  const sigB64: string | undefined =
    sess.seekerSignatureB64 ?? sess.ikaUskSignatureB64 ?? sess.solanaMwaAccount?.ikaUskSignatureB64;
  if (typeof sigB64 === 'string' && sigB64.length > 0) {
    const sigBytes = b64Decode(sigB64);
    return x25519InboxSecretFromBytes(sigBytes, 0);
  }
  const prfB64: string | undefined = sess.passkeyPrfOutputB64;
  if (typeof prfB64 === 'string' && prfB64.length > 0) {
    const prf = b64Decode(prfB64);
    if (prf.length !== 32) {
      throw new EncryptionBackendError(
        'direct-ed25519',
        'protocol-error',
        `passkey prf output must be 32 bytes, got ${prf.length}`,
      );
    }
    return x25519InboxSecretFromBytes(prf, 0);
  }
  throw new EncryptionBackendError(
    'direct-ed25519',
    'wrong-vault',
    'no inbox-eligible root secret on active session (need mnemonic / mwa signature / passkey prf)',
  );
}

/** public entry: resolve the active vault's X25519 inbox PUBLIC key. UI-friendly shape. */
export async function getActiveInboxX25519PublicKey(): Promise<Uint8Array> {
  const secret = await resolveActiveInboxSecret();
  return x25519.getPublicKey(secret);
}

export const directEd25519Backend: EncryptionBackend = {
  id: 'direct-ed25519',
  capabilities: CAPABILITIES,

  async encryptForRecipient(plaintext: Uint8Array, recipient: RecipientId): Promise<EncryptedRef> {
    if (recipient.kind !== 'ed25519') {
      throw new EncryptionBackendError(
        'direct-ed25519',
        'unsupported-recipient',
        `direct-ed25519 only supports recipient.kind === 'ed25519' (X25519-inbox-pubkey form); got '${recipient.kind}'`,
      );
    }
    if (!(recipient.pubkey instanceof Uint8Array) || recipient.pubkey.length !== 32) {
      throw new EncryptionBackendError(
        'direct-ed25519',
        'protocol-error',
        `recipient pubkey must be a 32-byte X25519 public key; got length ${recipient.pubkey?.length ?? 'undefined'}`,
      );
    }
    if (plaintext.length > CAPABILITIES.maxInlinePlaintextBytes) {
      throw new EncryptionBackendError(
        'direct-ed25519',
        'protocol-error',
        `plaintext exceeds inline cap (${plaintext.length} > ${CAPABILITIES.maxInlinePlaintextBytes}); pair with walrus for larger payloads`,
      );
    }

    // ephemeral X25519 keypair for this envelope.
    const ephemeralKeys = x25519.keygen();
    const sharedSecret = x25519.getSharedSecret(ephemeralKeys.secretKey, recipient.pubkey);

    // HKDF-SHA256 -> 32-byte AES key.
    const aesKeyBytes = hkdf(sha256, sharedSecret, undefined, HKDF_INFO, AES_KEY_LENGTH_BYTES);

    // random 12-byte IV.
    const iv = crypto.getRandomValues(new Uint8Array(AES_IV_LENGTH_BYTES));

    // import as non-extractable AES-GCM key + encrypt. casts to BufferSource navigate the
    // strict @types/node@22 `Uint8Array<ArrayBufferLike>` vs lib.dom `ArrayBufferView<ArrayBuffer>`
    // disagreement; runtime types are correct (raw Uint8Array bytes).
    const aesKey = await crypto.subtle.importKey(
      'raw',
      aesKeyBytes as unknown as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['encrypt'],
    );
    const ciphertextWithTag = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        aesKey,
        plaintext as unknown as BufferSource,
      ),
    );

    return {
      backend: 'direct-ed25519',
      payload: {
        ephemeralPubkeyB64: b64Encode(ephemeralKeys.publicKey),
        bodyCiphertextB64: b64Encode(ciphertextWithTag),
        bodyIvB64: b64Encode(iv),
        recipientPubkeyB64: b64Encode(recipient.pubkey),
      },
      createdAtMs: Date.now(),
    };
  },

  async decrypt(ref: EncryptedRef): Promise<Uint8Array> {
    if (ref.backend !== 'direct-ed25519') {
      throw new EncryptionBackendError(
        'direct-ed25519',
        'protocol-error',
        `expected backend 'direct-ed25519', got '${ref.backend}'`,
      );
    }
    const payload = ref.payload;
    const ephemeralPubkey = b64Decode(payload.ephemeralPubkeyB64);
    if (ephemeralPubkey.length !== 32) {
      throw new EncryptionBackendError(
        'direct-ed25519',
        'protocol-error',
        `ephemeral pubkey must be 32 bytes, got ${ephemeralPubkey.length}`,
      );
    }
    const expectedRecipientPubkey = b64Decode(payload.recipientPubkeyB64);

    const inboxSecret = await resolveActiveInboxSecret();
    const inboxPubkey = x25519.getPublicKey(inboxSecret);

    // sanity: the active vault's inbox pubkey should match the ref's recipient pubkey.
    // if not, the ref was encrypted for a different inbox; surface a clean error.
    if (
      expectedRecipientPubkey.length === 32 &&
      !uint8ArraysEqual(inboxPubkey, expectedRecipientPubkey)
    ) {
      throw new EncryptionBackendError(
        'direct-ed25519',
        'wrong-vault',
        'active vault inbox pubkey does not match the ref recipient pubkey; this envelope was encrypted for a different vault',
      );
    }

    const sharedSecret = x25519.getSharedSecret(inboxSecret, ephemeralPubkey);
    const aesKeyBytes = hkdf(sha256, sharedSecret, undefined, HKDF_INFO, AES_KEY_LENGTH_BYTES);
    const aesKey = await crypto.subtle.importKey(
      'raw',
      aesKeyBytes as unknown as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );

    const ciphertext = b64Decode(payload.bodyCiphertextB64);
    const iv = b64Decode(payload.bodyIvB64);
    if (iv.length !== AES_IV_LENGTH_BYTES) {
      throw new EncryptionBackendError(
        'direct-ed25519',
        'protocol-error',
        `iv must be ${AES_IV_LENGTH_BYTES} bytes, got ${iv.length}`,
      );
    }
    let plaintextBuf: ArrayBuffer;
    try {
      plaintextBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        aesKey,
        ciphertext as unknown as BufferSource,
      );
    } catch {
      throw new EncryptionBackendError(
        'direct-ed25519',
        'protocol-error',
        'AES-GCM auth tag failed; ciphertext / iv / shared key inconsistent',
      );
    }
    return new Uint8Array(plaintextBuf);
  },
};

function uint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** test-only: re-export helpers so tests can drive the decrypt path without a real session. */
export const __test__ = {
  b64Encode,
  b64Decode,
  HKDF_INFO,
  AES_KEY_LENGTH_BYTES,
  AES_IV_LENGTH_BYTES,
};
