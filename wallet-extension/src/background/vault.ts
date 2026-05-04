/**
 * chromatika vault crypto: Argon2id KDF + AES-GCM 256.
 *
 * v3 (legacy, single-envelope):
 *   password → argon2id → AES-GCM key. that key encrypts the vault payload directly.
 *   one key, one unlock method. fine for password-only wallets but breaks down when a passkey
 *   vault wants to coexist with an hd vault (forces a shared password).
 *
 * v4 (multi-envelope):
 *   random 32-byte master key encrypts the vault payload with AES-GCM (fresh iv per write).
 *   each unlock method contributes an envelope: an AES-GCM-wrapped copy of the master key under
 *   a method-specific KEK. envelope kinds:
 *     - password: KEK = argon2id(password, salt) (same params as v3)
 *     - passkey-prf: KEK = HKDF(prfSecret, info=ENVELOPE_KEK_INFO_PASSKEY)
 *     - wallet-signature: KEK = HKDF(walletSig, info=ENVELOPE_KEK_INFO_WALLET_SIG)
 *     - recovery-words: KEK = HKDF(bip39Seed, info=ENVELOPE_KEK_INFO_RECOVERY)
 *   any envelope unwraps the same master key. mixed wallets (hd-with-password + passkey-vault)
 *   carry both envelopes and the user picks an unlock method on the unlock screen.
 *
 * KDF: Argon2id (RFC 9106) via @noble/hashes - pure JS, no WASM, runs fine in MV3 SW.
 * default params follow RFC 9106 §4 second option (memory-light): t=3, m=65536 KiB (64 MB), p=4, dkLen=32.
 * key: AES-GCM 256, imported as a NON-EXTRACTABLE `CryptoKey` so AES bytes never sit in JS heap
 *      after importKey returns. encrypt / decrypt go through Web Crypto.
 *
 * cache rehydrate (after SW restart) imports cached master-key bytes the same way - bytes only
 * touch JS during import, then live behind the Web Crypto opaque handle.
 */

import { argon2idAsync } from '@noble/hashes/argon2.js';

const ALGO = 'AES-GCM';
const KEY_LEN_BITS = 256;
const KEY_LEN_BYTES = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

/** RFC 9106 §4 second-option params (memory-light, ~250-500 ms on a modern laptop). */
const SAFE_ARGON2ID_PARAMS = { t: 3, m: 65536, p: 4 } as const;

/** tests-only cheap params (`pnpm test:fast`). the round-trip property doesn't depend on
 *  cost factor - only correctness does - so dropping cost shaves seconds off the suite without
 *  weakening what the tests actually assert. NEVER use these for real wallets: it'd let any
 *  password crack in milliseconds. gated on a process env var so the MV3 SW (whose bootstrap
 *  shim provides an empty `process.env`) physically can't see the flag at runtime. ✨ */
const FAST_TEST_ARGON2ID_PARAMS = { t: 1, m: 1024, p: 1 } as const;

const useFastKdf = (() => {
  try {
    return typeof process !== 'undefined' && process.env?.CHROMATIKA_TEST_FAST_KDF === '1';
  } catch {
    return false;
  }
})();

export const ARGON2ID_PARAMS = Object.freeze(
  useFastKdf ? FAST_TEST_ARGON2ID_PARAMS : SAFE_ARGON2ID_PARAMS,
);

export interface VaultKdfMeta {
  kdf: 'argon2id';
  /** base64 salt (16 random bytes) */
  salt: string;
  /** time cost (passes) */
  t: number;
  /** memory cost in KiB */
  m: number;
  /** parallelism */
  p: number;
}

export interface VaultBlobV3 {
  v: 3;
  kdf: 'argon2id';
  salt: string;
  t: number;
  m: number;
  p: number;
  /** base64 12-byte IV */
  iv: string;
  /** base64 ciphertext + GCM tag */
  data: string;
}

/**
 * v4 multi-envelope blob. unlike v3 the password (or any auth method) decrypts ONLY the
 * envelope's wrapped master key - the master key then decrypts `data`. several envelopes can
 * coexist; any of them recovers the same master key.
 */
export interface VaultBlobV4 {
  v: 4;
  envelopes: VaultEnvelope[];
  /** base64 12-byte IV - rotates per write */
  iv: string;
  /** base64 ciphertext + GCM tag (master-key-encrypted vault payload) */
  data: string;
}

/** any envelope kind. discriminated union; `kind` is enough to dispatch unlock. */
export type VaultEnvelope =
  | PasswordEnvelope
  | PasskeyPrfEnvelope
  | WalletSignatureEnvelope
  | RecoveryWordsEnvelope;

interface EnvelopeBase {
  /** unique within the blob, e.g. `'env-pw-1'`, `'env-passkey-1'`. UI uses this for selection. */
  id: string;
  /** human label shown on the unlock screen, e.g. `'password'`, `'passkey (default)'`. */
  label: string;
  /** ms timestamp the envelope was added; ui sorts oldest-first. */
  addedAtEpochMs: number;
  /** base64 12-byte AES-GCM IV used to wrap the master key under this envelope's KEK. */
  wrapIv: string;
  /** base64 ciphertext: AES-GCM(KEK, masterKeyBytes) + GCM tag. 32 bytes plaintext → 48 bytes ct. */
  wrappedMasterKey: string;
}

/** password envelope - KEK = argon2id(password, salt). same params as v3 for parity. */
export interface PasswordEnvelope extends EnvelopeBase {
  kind: 'password';
  kdf: 'argon2id';
  /** base64 16-byte salt - stable per envelope across re-saves. */
  salt: string;
  /** argon2id time cost (passes). */
  t: number;
  /** argon2id memory cost in KiB. */
  m: number;
  /** argon2id parallelism. */
  p: number;
}

/** passkey envelope - KEK = HKDF(prfSecret, info=ENVELOPE_KEK_INFO_PASSKEY). */
export interface PasskeyPrfEnvelope extends EnvelopeBase {
  kind: 'passkey-prf';
  /** base64url(`credential.rawId`) - passed to `provider.get(challenge, credentialId)` so the
   *  OS passkey dialog scopes to this credential when the user has multiple registered. */
  credentialIdB64Url: string;
  /** rpId at registration. for chrome extensions that's `chrome.runtime.id`. */
  rpId: string;
  /** base64 32-byte salt fed to the webauthn `prf.eval.first` extension. stable per envelope. */
  prfSaltB64: string;
}

/**
 * wallet-signature envelope - KEK = HKDF(walletSig, info=ENVELOPE_KEK_INFO_WALLET_SIG). used by
 * waap (deterministic ECDSA over `IKA_USK_DERIVATION_MESSAGE`) and seeker / wc (Ed25519 RFC8032).
 */
export interface WalletSignatureEnvelope extends EnvelopeBase {
  kind: 'wallet-signature';
  /** which protocol the unlock dialog should drive to reproduce the signature. */
  source: 'waap' | 'seeker' | 'walletconnect';
  /** sui address (waap) or solana address (seeker / wc) - UI hint + signer selection. */
  address: string;
  /** label for the wallet-standard / mwa account, e.g. social provider for waap. */
  hint?: string;
}

/** recovery-words envelope - KEK = HKDF(bip39Seed, info=ENVELOPE_KEK_INFO_RECOVERY). */
export interface RecoveryWordsEnvelope extends EnvelopeBase {
  kind: 'recovery-words';
  wordCount: 12 | 24;
}

/** stable HKDF info strings. NEVER change these - clients in the field rely on the byte values. */
export const ENVELOPE_KEK_INFO_PASSKEY = 'chromatika.envelope.passkey-prf.v1' as const;
export const ENVELOPE_KEK_INFO_WALLET_SIG = 'chromatika.envelope.wallet-signature.v1' as const;
export const ENVELOPE_KEK_INFO_RECOVERY = 'chromatika.envelope.recovery-words.v1' as const;

function toBase64(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf));
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** random KDF meta (fresh salt + default params). new vaults start here. */
export function freshKdfMeta(): VaultKdfMeta {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  return {
    kdf: 'argon2id',
    salt: toBase64(salt),
    t: ARGON2ID_PARAMS.t,
    m: ARGON2ID_PARAMS.m,
    p: ARGON2ID_PARAMS.p,
  };
}

/**
 * run argon2id over the password and return the raw 32-byte derived key.
 * bytes briefly live in JS heap; pass straight to `importKeyBytesToVaultKey` and zero after.
 */
export async function deriveVaultKeyBytes(password: string, kdfMeta: VaultKdfMeta): Promise<Uint8Array> {
  if (kdfMeta.kdf !== 'argon2id') throw new Error('Unsupported vault KDF');
  const salt = fromBase64(kdfMeta.salt);
  const pwBytes = new TextEncoder().encode(password);
  return argon2idAsync(pwBytes, salt, {
    t: kdfMeta.t,
    m: kdfMeta.m,
    p: kdfMeta.p,
    dkLen: KEY_LEN_BYTES,
  });
}

/**
 * import 32 raw key bytes as a non-extractable AES-GCM `CryptoKey`.
 * after this, bytes can be zeroed; the key handle is the only path to encrypt/decrypt.
 */
export async function importKeyBytesToVaultKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  if (keyBytes.length !== KEY_LEN_BYTES) {
    throw new Error(`Invalid vault key length: expected ${KEY_LEN_BYTES} bytes, got ${keyBytes.length}`);
  }
  return crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: ALGO, length: KEY_LEN_BITS },
    /* extractable */ false,
    ['encrypt', 'decrypt'],
  );
}

/** convenience: derive bytes + import + zero the bytes. returns the key handle only. */
export async function deriveVaultKey(password: string, kdfMeta: VaultKdfMeta): Promise<CryptoKey> {
  const bytes = await deriveVaultKeyBytes(password, kdfMeta);
  try {
    return await importKeyBytesToVaultKey(bytes);
  } finally {
    bytes.fill(0);
  }
}

/** encrypt with the session vault key; reuses the blob's KDF salt/params (only IV rotates). */
export async function encryptToBlob(
  key: CryptoKey,
  kdfMeta: VaultKdfMeta,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const data = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: ALGO, iv: iv as BufferSource }, key, data);
  const blob: VaultBlobV3 = {
    v: 3,
    kdf: 'argon2id',
    salt: kdfMeta.salt,
    t: kdfMeta.t,
    m: kdfMeta.m,
    p: kdfMeta.p,
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(cipher)),
  };
  return JSON.stringify(blob);
}

/** parse a stored blob, validating the schema. pre-release: no v2 (PBKDF2) migration. */
export function parseVaultBlob(blobJson: string): VaultBlobV3 {
  const raw = JSON.parse(blobJson) as Partial<VaultBlobV3> & { iterations?: number; v?: number };
  if (raw.v !== 3 || raw.kdf !== 'argon2id') {
    if (raw.iterations || raw.v === undefined) {
      throw new Error(
        'Legacy PBKDF2 vault detected. Pre-release: clear chromatika extension storage and onboard again.',
      );
    }
    throw new Error('Unsupported vault blob version');
  }
  if (
    typeof raw.salt !== 'string' ||
    typeof raw.iv !== 'string' ||
    typeof raw.data !== 'string' ||
    typeof raw.t !== 'number' ||
    typeof raw.m !== 'number' ||
    typeof raw.p !== 'number'
  ) {
    throw new Error('Invalid vault blob shape');
  }
  return {
    v: 3,
    kdf: 'argon2id',
    salt: raw.salt,
    iv: raw.iv,
    data: raw.data,
    t: raw.t,
    m: raw.m,
    p: raw.p,
  };
}

export function blobToKdfMeta(blob: VaultBlobV3): VaultKdfMeta {
  return { kdf: 'argon2id', salt: blob.salt, t: blob.t, m: blob.m, p: blob.p };
}

/** decrypt using a session key (no password derivation). */
export async function decryptWithKey(key: CryptoKey, blob: VaultBlobV3): Promise<string> {
  const iv = fromBase64(blob.iv);
  const plain = await crypto.subtle.decrypt(
    { name: ALGO, iv: iv as BufferSource },
    key,
    fromBase64(blob.data) as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

/** derive a fresh key from password + the blob's stored KDF params, then decrypt. */
export async function decryptVaultWithPassword(
  password: string,
  blobJson: string,
): Promise<{ key: CryptoKey; kdfMeta: VaultKdfMeta; plaintext: string }> {
  const blob = parseVaultBlob(blobJson);
  const kdfMeta = blobToKdfMeta(blob);
  const key = await deriveVaultKey(password, kdfMeta);
  let plaintext: string;
  try {
    plaintext = await decryptWithKey(key, blob);
  } catch (e) {
    // GCM tag mismatch or shape error - almost always wrong password.
    throw new Error('Wrong password');
  }
  return { key, kdfMeta, plaintext };
}

/**
 * initial vault encryption: fresh salt + fresh IV + fresh derived key.
 * returned key + kdfMeta seed the new session and the unlock cache.
 */
export async function encryptVaultFresh(
  password: string,
  plaintext: string,
): Promise<{ blob: string; key: CryptoKey; kdfMeta: VaultKdfMeta }> {
  const kdfMeta = freshKdfMeta();
  const key = await deriveVaultKey(password, kdfMeta);
  const blob = await encryptToBlob(key, kdfMeta, plaintext);
  return { blob, key, kdfMeta };
}

export type { VaultKdfMeta as KdfMeta };

/* =============================================================================
 * v4 multi-envelope helpers
 * ============================================================================= */

const MASTER_KEY_LEN = 32;

/** generate a fresh 256-bit master key. only handed out at vault creation. */
export function freshMasterKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(MASTER_KEY_LEN));
}

/** import 32 master-key bytes as a non-extractable AES-GCM `CryptoKey`. */
export async function importMasterKeyBytes(masterKeyBytes: Uint8Array): Promise<CryptoKey> {
  if (masterKeyBytes.length !== MASTER_KEY_LEN) {
    throw new Error(`Invalid master key length: expected ${MASTER_KEY_LEN}, got ${masterKeyBytes.length}`);
  }
  return crypto.subtle.importKey(
    'raw',
    masterKeyBytes as BufferSource,
    { name: ALGO, length: KEY_LEN_BITS },
    /* extractable */ false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * derive a KEK (key encryption key) via HKDF-SHA256 from arbitrary input keying material.
 * used for non-password envelope kinds where the secret is already high-entropy (PRF output,
 * wallet signature, BIP39 seed). same `info` string yields the same KEK across calls.
 */
export async function hkdfDeriveKek(ikm: Uint8Array, info: string): Promise<CryptoKey> {
  const ikmKey = await crypto.subtle.importKey(
    'raw',
    ikm as BufferSource,
    'HKDF',
    /* extractable */ false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // empty salt is fine - the ikm itself is high-entropy and the `info` string supplies
      // domain separation. webcrypto requires a BufferSource here, not undefined.
      salt: new Uint8Array(0) as BufferSource,
      info: new TextEncoder().encode(info) as BufferSource,
    },
    ikmKey,
    { name: ALGO, length: KEY_LEN_BITS },
    /* extractable */ false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * argon2id-derive a KEK for a password envelope. mirrors v3's `deriveVaultKeyBytes`,
 * but the result wraps the master key instead of decrypting the payload directly.
 */
export async function passwordKekBytes(password: string, kdfMeta: VaultKdfMeta): Promise<Uint8Array> {
  return deriveVaultKeyBytes(password, kdfMeta);
}

/** wrap a master key under a KEK (any AES-GCM `CryptoKey`); returns wrap iv + ciphertext. */
export async function wrapMasterKey(
  masterKeyBytes: Uint8Array,
  kek: CryptoKey,
): Promise<{ wrapIv: string; wrappedMasterKey: string }> {
  if (masterKeyBytes.length !== MASTER_KEY_LEN) {
    throw new Error('Invalid master key length for wrap');
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = await crypto.subtle.encrypt(
    { name: ALGO, iv: iv as BufferSource },
    kek,
    masterKeyBytes as BufferSource,
  );
  return { wrapIv: toBase64(iv), wrappedMasterKey: toBase64(new Uint8Array(ct)) };
}

/** unwrap a master key (returns raw bytes; caller imports + zeroes). throws on tag mismatch. */
export async function unwrapMasterKey(
  envelope: { wrapIv: string; wrappedMasterKey: string },
  kek: CryptoKey,
): Promise<Uint8Array> {
  const iv = fromBase64(envelope.wrapIv);
  const ct = fromBase64(envelope.wrappedMasterKey);
  const plain = await crypto.subtle.decrypt(
    { name: ALGO, iv: iv as BufferSource },
    kek,
    ct as BufferSource,
  );
  const out = new Uint8Array(plain);
  if (out.length !== MASTER_KEY_LEN) {
    throw new Error('Unwrapped master key has wrong length');
  }
  return out;
}

/** AES-GCM encrypt the vault payload directly under the master key with a fresh IV. */
export async function encryptPayloadV4(
  masterKey: CryptoKey,
  plaintext: string,
): Promise<{ iv: string; data: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const data = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt(
    { name: ALGO, iv: iv as BufferSource },
    masterKey,
    data as BufferSource,
  );
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(ct)) };
}

export async function decryptPayloadV4(masterKey: CryptoKey, blob: VaultBlobV4): Promise<string> {
  const iv = fromBase64(blob.iv);
  const plain = await crypto.subtle.decrypt(
    { name: ALGO, iv: iv as BufferSource },
    masterKey,
    fromBase64(blob.data) as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

/** build a v4 password envelope from password + new salt + a wrapped master key. */
export async function buildPasswordEnvelope(
  masterKeyBytes: Uint8Array,
  password: string,
  opts?: { id?: string; label?: string; addedAtEpochMs?: number; reuseKdfMeta?: VaultKdfMeta },
): Promise<PasswordEnvelope> {
  const kdfMeta = opts?.reuseKdfMeta ?? freshKdfMeta();
  const kekBytes = await passwordKekBytes(password, kdfMeta);
  let kek: CryptoKey;
  try {
    kek = await importKeyBytesToVaultKey(kekBytes);
  } finally {
    kekBytes.fill(0);
  }
  const { wrapIv, wrappedMasterKey } = await wrapMasterKey(masterKeyBytes, kek);
  return {
    id: opts?.id ?? `env-pw-${Date.now()}`,
    kind: 'password',
    label: opts?.label ?? 'password',
    addedAtEpochMs: opts?.addedAtEpochMs ?? Date.now(),
    kdf: 'argon2id',
    salt: kdfMeta.salt,
    t: kdfMeta.t,
    m: kdfMeta.m,
    p: kdfMeta.p,
    wrapIv,
    wrappedMasterKey,
  };
}

/** build a v4 passkey envelope from a popup-collected prfSecret + identifying fields. */
export async function buildPasskeyPrfEnvelope(
  masterKeyBytes: Uint8Array,
  prfSecret: Uint8Array,
  fields: { credentialIdB64Url: string; rpId: string; prfSaltB64: string; label?: string; id?: string },
): Promise<PasskeyPrfEnvelope> {
  const kek = await hkdfDeriveKek(prfSecret, ENVELOPE_KEK_INFO_PASSKEY);
  const { wrapIv, wrappedMasterKey } = await wrapMasterKey(masterKeyBytes, kek);
  return {
    id: fields.id ?? `env-passkey-${Date.now()}`,
    kind: 'passkey-prf',
    label: fields.label ?? 'passkey',
    addedAtEpochMs: Date.now(),
    credentialIdB64Url: fields.credentialIdB64Url,
    rpId: fields.rpId,
    prfSaltB64: fields.prfSaltB64,
    wrapIv,
    wrappedMasterKey,
  };
}

export async function buildWalletSignatureEnvelope(
  masterKeyBytes: Uint8Array,
  signature: Uint8Array,
  fields: {
    source: 'waap' | 'seeker' | 'walletconnect';
    address: string;
    hint?: string;
    label?: string;
    id?: string;
  },
): Promise<WalletSignatureEnvelope> {
  const kek = await hkdfDeriveKek(signature, ENVELOPE_KEK_INFO_WALLET_SIG);
  const { wrapIv, wrappedMasterKey } = await wrapMasterKey(masterKeyBytes, kek);
  return {
    id: fields.id ?? `env-${fields.source}-${Date.now()}`,
    kind: 'wallet-signature',
    label: fields.label ?? fields.source,
    addedAtEpochMs: Date.now(),
    source: fields.source,
    address: fields.address,
    hint: fields.hint,
    wrapIv,
    wrappedMasterKey,
  };
}

export async function buildRecoveryWordsEnvelope(
  masterKeyBytes: Uint8Array,
  bip39Seed: Uint8Array,
  fields: { wordCount: 12 | 24; label?: string; id?: string },
): Promise<RecoveryWordsEnvelope> {
  const kek = await hkdfDeriveKek(bip39Seed, ENVELOPE_KEK_INFO_RECOVERY);
  const { wrapIv, wrappedMasterKey } = await wrapMasterKey(masterKeyBytes, kek);
  return {
    id: fields.id ?? `env-recovery-${Date.now()}`,
    kind: 'recovery-words',
    label: fields.label ?? `${fields.wordCount}-word phrase`,
    addedAtEpochMs: Date.now(),
    wordCount: fields.wordCount,
    wrapIv,
    wrappedMasterKey,
  };
}

/** parse v4. throws on shape mismatch. v3 callers must check version first. */
export function parseVaultBlobV4(blobJson: string): VaultBlobV4 {
  const raw = JSON.parse(blobJson) as Partial<VaultBlobV4> & { v?: number };
  if (raw.v !== 4) throw new Error('Not a v4 vault blob');
  if (!Array.isArray(raw.envelopes) || typeof raw.iv !== 'string' || typeof raw.data !== 'string') {
    throw new Error('Invalid v4 blob shape');
  }
  return { v: 4, envelopes: raw.envelopes as VaultEnvelope[], iv: raw.iv, data: raw.data };
}

/** detect blob version without throwing. used for v3 → v4 lazy migration dispatch. */
export function detectVaultBlobVersion(blobJson: string): 3 | 4 | 'unknown' {
  try {
    const raw = JSON.parse(blobJson) as { v?: number };
    if (raw.v === 3) return 3;
    if (raw.v === 4) return 4;
  } catch {
    /* fall through */
  }
  return 'unknown';
}

/** build a fresh v4 blob from an array of envelopes + an encrypted payload. */
export async function buildV4BlobFromEnvelopes(
  envelopes: VaultEnvelope[],
  masterKey: CryptoKey,
  payloadJson: string,
): Promise<string> {
  if (envelopes.length === 0) throw new Error('v4 blob requires at least one envelope');
  const { iv, data } = await encryptPayloadV4(masterKey, payloadJson);
  const blob: VaultBlobV4 = { v: 4, envelopes, iv, data };
  return JSON.stringify(blob);
}
