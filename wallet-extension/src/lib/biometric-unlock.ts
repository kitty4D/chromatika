/**
 * optional "unlock with biometrics" using WebAuthn passkeys + largeBlob (Chrome 108+).
 * the chromatika app password is sealed inside the passkey blob after user verification, not stored in plaintext in chrome.storage.local.
 * falls back gracefully when unsupported (extension origin / platform limits).
 */

import { base64 } from '@scure/base';
import { STORAGE_KEYS } from '@/background/storage';

const STORAGE_CRED = STORAGE_KEYS.PASSKEY_CRED_ID_V1;

function randomChallenge(): ArrayBuffer {
  const u = new Uint8Array(32);
  crypto.getRandomValues(u);
  return u.buffer;
}

function rpForExtension(): PublicKeyCredentialRpEntity {
  const id =
    typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome.runtime.id : 'chromatika.local';
  return { id, name: 'Chromatika' };
}

function userIdBytes(): Uint8Array {
  const u = new Uint8Array(16);
  crypto.getRandomValues(u);
  return u;
}

async function packEncryptedPassword(password: string): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const enc = new TextEncoder();
  const pt = enc.encode(password);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const version = new Uint8Array([1]);
  const out = new Uint8Array(1 + 12 + 32 + ct.length);
  out.set(version, 0);
  out.set(iv, 1);
  out.set(rawKey, 13);
  out.set(ct, 45);
  return out.buffer;
}

async function unpackDecryptedPassword(blob: ArrayBuffer): Promise<string | null> {
  try {
    const u = new Uint8Array(blob);
    if (u.length < 1 + 12 + 32 + 16 || u[0] !== 1) return null;
    const iv = u.slice(1, 13);
    const rawKey = u.slice(13, 45);
    const ct = u.slice(45);
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export function biometricUnlockSupported(): boolean {
  return (
    typeof globalThis.PublicKeyCredential !== 'undefined' &&
    globalThis.isSecureContext === true &&
    typeof navigator.credentials?.create === 'function'
  );
}

export function hasBiometricUnlockEnrollment(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_CRED], (r) => {
      const id = r[STORAGE_CRED];
      resolve(typeof id === 'string' && id.length > 0);
    });
  });
}

export function clearBiometricUnlockEnrollment(): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([STORAGE_CRED], () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/**
 * create a passkey and store an AES-wrapped copy of `password` in the credential largeBlob.
 * requires a user gesture (call from a button click).
 */
export async function enrollBiometricUnlock(password: string): Promise<void> {
  if (!biometricUnlockSupported()) throw new Error('WebAuthn is not available here');
  if (password.length < 8) throw new Error('Password too short');

  const challenge = randomChallenge();
  const createOptions: CredentialCreationOptions = {
    publicKey: {
      challenge,
      rp: rpForExtension(),
      user: { id: new Uint8Array(userIdBytes()), name: 'chromatika', displayName: 'Chromatika' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        userVerification: 'required',
        residentKey: 'preferred',
      },
      extensions: {
        largeBlob: { support: 'preferred' },
      } as AuthenticationExtensionsClientInputs,
    },
  };

  const cred = (await navigator.credentials.create(createOptions)) as PublicKeyCredential | null;
  if (!cred?.rawId) throw new Error('Passkey creation was cancelled');

  const packed = await packEncryptedPassword(password);
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: randomChallenge(),
      allowCredentials: [{ type: 'public-key', id: cred.rawId }],
      userVerification: 'required',
      extensions: {
        largeBlob: { write: packed },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error('Could not seal unlock secret to your passkey');

  const ext = assertion.getClientExtensionResults()?.largeBlob as { written?: boolean } | undefined;
  if (!ext?.written) {
    throw new Error(
      'This browser did not store the unlock secret on your passkey (largeBlob). Use password unlock, or try Chrome with a platform passkey.',
    );
  }

  const credIdB64 = base64.encode(new Uint8Array(cred.rawId));
  await new Promise<void>((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_CRED]: credIdB64 }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** returns decrypted app password after WebAuthn UV, or null if cancelled / not enrolled. */
export async function unlockPasswordWithBiometric(): Promise<string | null> {
  if (!biometricUnlockSupported()) return null;

  const credIdB64: string | undefined = await new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_CRED], (r) => resolve(r[STORAGE_CRED] as string | undefined));
  });
  if (!credIdB64) return null;

  let rawId: Uint8Array;
  try {
    rawId = base64.decode(credIdB64);
  } catch {
    return null;
  }

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: randomChallenge(),
      allowCredentials: [{ type: 'public-key', id: new Uint8Array(rawId) }],
      userVerification: 'required',
      extensions: {
        largeBlob: { read: true },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) return null;

  const lb = assertion.getClientExtensionResults()?.largeBlob as { blob?: ArrayBuffer } | undefined;
  const blob = lb?.blob;
  if (!blob) return null;

  return unpackDecryptedPassword(blob);
}
