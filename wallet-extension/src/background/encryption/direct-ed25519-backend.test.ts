/**
 * tests for `DirectEd25519Backend`. mocks `getSession` so `decrypt` resolves the inbox
 * secret deterministically. round-trip + tamper + wrong-recipient + cross-vault sanity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { x25519InboxSecretFromBytes } from '@/background/keyring/hd';

// two test inbox secrets derived from independent root bytes.
const ROOT_A = new Uint8Array(32);
for (let i = 0; i < ROOT_A.length; i++) ROOT_A[i] = (i * 7 + 3) & 0xff;
const ROOT_B = new Uint8Array(32);
for (let i = 0; i < ROOT_B.length; i++) ROOT_B[i] = (i * 11 + 5) & 0xff;

const SECRET_A = x25519InboxSecretFromBytes(ROOT_A, 0);
const SECRET_B = x25519InboxSecretFromBytes(ROOT_B, 0);
const PUBKEY_A = x25519.getPublicKey(SECRET_A);
const PUBKEY_B = x25519.getPublicKey(SECRET_B);

// in-memory session swap used to drive `resolveActiveInboxSecret`. the mock returns the
// vault's ROOT bytes (not the inbox secret); the backend's `resolveActiveInboxSecret` calls
// `x25519InboxSecretFromBytes(rootBytes, 0)` to derive the secret. so `activeRoot = ROOT_A`
// produces the secret `SECRET_A` and pubkey `PUBKEY_A`.
let activeRoot = ROOT_A;
function b64Encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

vi.mock('@/background/session', () => ({
  getSession: () => ({
    activeVaultId: 'vault-test',
    seekerSignatureB64: b64Encode(activeRoot),
  }),
}));

beforeEach(() => {
  activeRoot = ROOT_A;
});

afterEach(() => {
  vi.resetModules();
});

describe('directEd25519Backend.encryptForRecipient', () => {
  it('rejects non-ed25519 recipient kinds', async () => {
    const m = await import('./direct-ed25519-backend');
    await expect(
      m.directEd25519Backend.encryptForRecipient(new Uint8Array([1, 2, 3]), { kind: 'self' }),
    ).rejects.toThrow(/only supports recipient.kind === 'ed25519'/);
    await expect(
      m.directEd25519Backend.encryptForRecipient(new Uint8Array([1, 2, 3]), {
        kind: 'sui-address',
        address: '0xabc',
      }),
    ).rejects.toThrow(/only supports recipient.kind === 'ed25519'/);
  });

  it('rejects recipient pubkey of wrong length', async () => {
    const m = await import('./direct-ed25519-backend');
    await expect(
      m.directEd25519Backend.encryptForRecipient(new Uint8Array([1, 2, 3]), {
        kind: 'ed25519',
        pubkey: new Uint8Array(31),
      }),
    ).rejects.toThrow(/32-byte X25519 public key/);
  });

  it('rejects plaintext over inline cap', async () => {
    const m = await import('./direct-ed25519-backend');
    const big = new Uint8Array(8 * 1024 + 1);
    await expect(
      m.directEd25519Backend.encryptForRecipient(big, { kind: 'ed25519', pubkey: PUBKEY_B }),
    ).rejects.toThrow(/exceeds inline cap/);
  });

  it('produces a `direct-ed25519` ref with all 4 fields populated', async () => {
    const m = await import('./direct-ed25519-backend');
    const plaintext = new TextEncoder().encode('hello chromatika');
    const ref = await m.directEd25519Backend.encryptForRecipient(plaintext, {
      kind: 'ed25519',
      pubkey: PUBKEY_B,
    });
    expect(ref.backend).toBe('direct-ed25519');
    if (ref.backend !== 'direct-ed25519') throw new Error('typeguard');
    expect(ref.payload.ephemeralPubkeyB64.length).toBeGreaterThan(0);
    expect(ref.payload.bodyCiphertextB64.length).toBeGreaterThan(0);
    expect(ref.payload.bodyIvB64.length).toBeGreaterThan(0);
    expect(ref.payload.recipientPubkeyB64.length).toBeGreaterThan(0);
    expect(ref.createdAtMs).toBeGreaterThan(0);
  });
});

describe('directEd25519Backend.decrypt', () => {
  it('round-trips: encrypt to active vault\'s own pubkey, decrypt with active vault', async () => {
    const m = await import('./direct-ed25519-backend');
    activeRoot = ROOT_A;
    const plaintext = new TextEncoder().encode('round-trip plaintext');
    const ref = await m.directEd25519Backend.encryptForRecipient(plaintext, {
      kind: 'ed25519',
      pubkey: PUBKEY_A,
    });
    const decrypted = await m.directEd25519Backend.decrypt(ref);
    expect(new TextDecoder().decode(decrypted)).toBe('round-trip plaintext');
  });

  it('cross-vault: encrypt for B\'s pubkey, switch active to B, decrypt succeeds', async () => {
    const m = await import('./direct-ed25519-backend');
    activeRoot = ROOT_A;
    const plaintext = new TextEncoder().encode('Alice -> Bob secret');
    const ref = await m.directEd25519Backend.encryptForRecipient(plaintext, {
      kind: 'ed25519',
      pubkey: PUBKEY_B,
    });
    // switch session to vault B
    activeRoot = ROOT_B;
    const decrypted = await m.directEd25519Backend.decrypt(ref);
    expect(new TextDecoder().decode(decrypted)).toBe('Alice -> Bob secret');
  });

  it('wrong-vault: encrypt for B, decrypt with A fails with `wrong-vault`', async () => {
    const m = await import('./direct-ed25519-backend');
    activeRoot = ROOT_A;
    const plaintext = new TextEncoder().encode('Alice -> Bob secret');
    const ref = await m.directEd25519Backend.encryptForRecipient(plaintext, {
      kind: 'ed25519',
      pubkey: PUBKEY_B,
    });
    // active is A; ref was for B
    await expect(m.directEd25519Backend.decrypt(ref)).rejects.toThrow(
      /active vault inbox pubkey does not match/,
    );
  });

  it('tamper: ciphertext modified -> AES-GCM auth fails cleanly', async () => {
    const m = await import('./direct-ed25519-backend');
    activeRoot = ROOT_A;
    const plaintext = new TextEncoder().encode('attestation');
    const ref = await m.directEd25519Backend.encryptForRecipient(plaintext, {
      kind: 'ed25519',
      pubkey: PUBKEY_A,
    });
    if (ref.backend !== 'direct-ed25519') throw new Error('typeguard');
    // flip a bit in the ciphertext
    const ct = atob(ref.payload.bodyCiphertextB64);
    const ctBytes = Uint8Array.from(ct, (c) => c.charCodeAt(0));
    ctBytes[0] = ctBytes[0]! ^ 0xff;
    const tamperedB64 = btoa(String.fromCharCode(...ctBytes));
    const tampered = {
      ...ref,
      payload: { ...ref.payload, bodyCiphertextB64: tamperedB64 },
    };
    await expect(m.directEd25519Backend.decrypt(tampered)).rejects.toThrow(/AES-GCM auth tag failed/);
  });

  it('tamper: iv modified -> AES-GCM auth fails cleanly', async () => {
    const m = await import('./direct-ed25519-backend');
    activeRoot = ROOT_A;
    const ref = await m.directEd25519Backend.encryptForRecipient(
      new TextEncoder().encode('attestation'),
      { kind: 'ed25519', pubkey: PUBKEY_A },
    );
    if (ref.backend !== 'direct-ed25519') throw new Error('typeguard');
    const iv = atob(ref.payload.bodyIvB64);
    const ivBytes = Uint8Array.from(iv, (c) => c.charCodeAt(0));
    ivBytes[0] = ivBytes[0]! ^ 0xff;
    const tamperedIvB64 = btoa(String.fromCharCode(...ivBytes));
    const tampered = { ...ref, payload: { ...ref.payload, bodyIvB64: tamperedIvB64 } };
    await expect(m.directEd25519Backend.decrypt(tampered)).rejects.toThrow(/AES-GCM auth tag failed/);
  });

  it('rejects ref with wrong backend tag', async () => {
    const m = await import('./direct-ed25519-backend');
    const fakeRef = {
      backend: 'encrypt-xyz' as const,
      payload: {} as never,
      createdAtMs: 1,
    };
    await expect(m.directEd25519Backend.decrypt(fakeRef as never)).rejects.toThrow(
      /expected backend 'direct-ed25519'/,
    );
  });
});

describe('getActiveInboxX25519PublicKey', () => {
  it('returns a 32-byte X25519 pubkey deterministically tied to the active session', async () => {
    const m = await import('./direct-ed25519-backend');
    activeRoot = ROOT_A;
    const pk1 = await m.getActiveInboxX25519PublicKey();
    expect(pk1).toEqual(PUBKEY_A);
    activeRoot = ROOT_B;
    const pk2 = await m.getActiveInboxX25519PublicKey();
    expect(pk2).toEqual(PUBKEY_B);
  });
});

describe('hd.x25519InboxSecretFromBytes', () => {
  it('is deterministic + index-stable', () => {
    const a0 = x25519InboxSecretFromBytes(ROOT_A, 0);
    const a0_again = x25519InboxSecretFromBytes(ROOT_A, 0);
    expect(a0).toEqual(a0_again);
    const a1 = x25519InboxSecretFromBytes(ROOT_A, 1);
    expect(a1).not.toEqual(a0);
  });

  it('different roots produce different secrets', () => {
    const a = x25519InboxSecretFromBytes(ROOT_A, 0);
    const b = x25519InboxSecretFromBytes(ROOT_B, 0);
    expect(a).not.toEqual(b);
  });

  it('does not collide with the ika seed derivation', async () => {
    // ika seed uses no domain prefix (just keccak(signature || index_le)); inbox uses
    // keccak(INBOX_X25519_DOMAIN_BYTES || rootSecret || index_le). they MUST differ.
    const { ikaRootSeedFromMwaSignature } = await import('@/background/keyring/hd');
    const ika = ikaRootSeedFromMwaSignature(ROOT_A, 0);
    const inbox = x25519InboxSecretFromBytes(ROOT_A, 0);
    expect(ika).not.toEqual(inbox);
  });
});
