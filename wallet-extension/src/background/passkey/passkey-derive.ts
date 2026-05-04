/**
 * pure helpers for sui passkey vaults. import-safe in any environment (no `window`, no
 * `chrome.runtime`, no webauthn). all webauthn / dom interaction lives in the popup-side
 * `passkey-provider-with-prf.ts`. this file is the bridge between background-side seed
 * derivation and the popup-collected webauthn artifacts.
 */

import { blake2b } from '@noble/hashes/blake2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { fromBase64 as fromB64, toBase64 as toB64 } from '@mysten/sui/utils';

/** webauthn `credential.rawId` is conventionally serialized as base64url (rfc 4648 §5). */
function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const padLen = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * SIP-9 sui address derivation: `blake2b_256(0x06 || pk_compressed)`. flag 0x06 = passkey
 * (distinct from plain secp256r1's 0x02). pk_compressed is the 33-byte sec1 compressed point.
 *
 * matches `PasskeyPublicKey.toSuiAddress()` in `@mysten/sui/keypairs/passkey` so a vault
 * record persisted via this helper resolves to the same address mysten reports for the same pk.
 */
export const SIP9_PASSKEY_FLAG = 0x06 as const;

export function suiAddressFromPasskeyPublicKey(publicKeyCompressed: Uint8Array): string {
  if (!(publicKeyCompressed instanceof Uint8Array) || publicKeyCompressed.length !== 33) {
    throw new Error('passkey sui address derivation expects a 33-byte compressed secp256r1 pk');
  }
  const preimage = new Uint8Array(1 + publicKeyCompressed.length);
  preimage[0] = SIP9_PASSKEY_FLAG;
  preimage.set(publicKeyCompressed, 1);
  // blake2b digest length 32 -> 64-char hex address. mysten formats with the `0x` prefix.
  const digest = blake2b(preimage, { dkLen: 32 });
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return `0x${hex}`;
}

/**
 * 32-byte deterministic prf salt for chromatika sui passkey vaults: `keccak256("chromatika.passkey.prf-salt.v1")`.
 *
 * **why a constant, not a random per-vault salt**: webauthn `prf.eval.first` outputs `HMAC(authenticator-credential-secret, salt)`.
 * the secret is per-credential and per-device, never leaves the authenticator. the salt is a
 * domain separator, NOT a secret (per webauthn spec). a chromatika-wide constant makes the prf
 * output deterministic from the passkey alone - on extension reinstall, the same passkey + same
 * (recomputable) salt re-derives the same prf, the same `UserShareEncryptionKeys` seed via
 * `ikaRootSeedFromPasskeyPRF`, and the same dwallet. without this, the salt was previously
 * persisted to the encrypted vault blob and wiped on reinstall - making passkey-only restore
 * impossible even with a synced passkey.
 *
 * different passkey credentials registered against the same chromatika rpId still produce
 * different prf outputs (different per-credential authenticator secrets), so `addPasskeyVault`
 * siblings stay distinct. multi-vault from the SAME credential uses the per-vault
 * `passkeyEncryptionIndex` field on `PasskeyVaultRecord`, plumbed through
 * `ikaRootSeedFromPasskeyPRF(prfSecret, encryptionKeyIndex)`.
 */
const CHROMATIKA_PRF_SALT_DOMAIN = 'chromatika.passkey.prf-salt.v1';
const CHROMATIKA_PRF_SALT_BYTES: Uint8Array = keccak_256(new TextEncoder().encode(CHROMATIKA_PRF_SALT_DOMAIN));

export function chromatikaPrfSalt(): Uint8Array {
  // return a copy so callers can't mutate the module-level buffer.
  return CHROMATIKA_PRF_SALT_BYTES.slice();
}

export function chromatikaPrfSaltB64(): string {
  return toB64(chromatikaPrfSalt());
}

/**
 * structural validation for a popup-collected register payload. prevents us from persisting
 * a malformed `PasskeyVaultRecord` that would later fail to unlock.
 */
export function validatePasskeyRegisterArtifacts(input: {
  credentialIdB64Url: string;
  publicKeyCompressedB64: string;
  prfSecretB64: string;
  prfSaltB64: string;
  rpId: string;
}): {
  credentialIdRaw: Uint8Array;
  publicKeyCompressed: Uint8Array;
  prfSecret: Uint8Array;
  prfSalt: Uint8Array;
  rpId: string;
} {
  const credentialIdRaw = fromBase64Url(input.credentialIdB64Url);
  if (credentialIdRaw.length === 0) throw new Error('passkey credentialId is empty');

  const publicKeyCompressed = fromB64(input.publicKeyCompressedB64);
  if (publicKeyCompressed.length !== 33) {
    throw new Error(`passkey publicKey must be 33 bytes (compressed secp256r1); got ${publicKeyCompressed.length}`);
  }
  const tag = publicKeyCompressed[0];
  if (tag !== 0x02 && tag !== 0x03) {
    throw new Error(`passkey publicKey must start with 0x02 or 0x03 (compressed secp256r1 tag); got 0x${tag.toString(16)}`);
  }

  const prfSecret = fromB64(input.prfSecretB64);
  if (prfSecret.length !== 32) {
    throw new Error(`passkey prf hmac-secret must be 32 bytes; got ${prfSecret.length}`);
  }

  const prfSalt = fromB64(input.prfSaltB64);
  if (prfSalt.length !== 32) {
    throw new Error(`passkey prf salt must be 32 bytes; got ${prfSalt.length}`);
  }

  const rpId = input.rpId.trim();
  if (!rpId) throw new Error('passkey rpId is required (chrome.runtime.id)');

  return { credentialIdRaw, publicKeyCompressed, prfSecret, prfSalt, rpId };
}

/** convenience encoders for hand-off back into vault-types.ts string fields. */
export function publicKeyCompressedToB64(pk: Uint8Array): string {
  return toB64(pk);
}

export function credentialIdToB64Url(rawId: Uint8Array): string {
  return toBase64Url(rawId);
}
