/**
 * round-trip test for `buildSuiPersonalMessageDigest`. validates that chromatika's intent +
 * BCS + BLAKE2b digest computation produces a value Mysten's `verifyPersonalMessageSignature`
 * accepts when paired with a standard ed25519 signature over that digest.
 *
 * strategy:
 *   1. build a deterministic ed25519 keypair via `@mysten/sui` `Ed25519Keypair.fromSecretKey`.
 *   2. compute the digest via chromatika's helper.
 *   3. sign the digest with the keypair (pure ed25519, no Mysten intent, that's already in the digest).
 *   4. serialize as Mysten's flag-prefixed signature with `toSerializedSignature`.
 *   5. run `verifyPersonalMessageSignature(message, serializedSig, { address })`, should return the address.
 *
 * if verify succeeds + returns the matching address, we know:
 *   - BCS encoding matches Mysten's
 *   - PersonalMessage intent prefix matches
 *   - BLAKE2b-256 matches
 *   - signature serialization shape (flag || sig || pubkey) matches
 *
 * bonus negative cases:
 *   - tampered message: verify rejects
 *   - wrong-length signature: throw
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed25519 from '@noble/ed25519';
import { hashes as edHashes } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { toSerializedSignature } from '@mysten/sui/cryptography';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { buildSuiPersonalMessageDigest } from '@/background/chains/sui-personal-message';

beforeAll(() => {
  // noble-ed25519 v3 sync APIs need sha512 injected. the keyring module does this at load time
  // in the SW, but tests don't import it.
  edHashes.sha512 = sha512;
});

// deterministic test keypair, fixed 32-byte secret so the signature is reproducible.
const TEST_SECRET = new Uint8Array(32).fill(0x42);

describe('buildSuiPersonalMessageDigest', () => {
  it('produces a 32-byte digest', () => {
    const digest = buildSuiPersonalMessageDigest(new TextEncoder().encode('hello'));
    expect(digest.length).toBe(32);
  });

  it('is deterministic — same input → same digest', () => {
    const a = buildSuiPersonalMessageDigest(new TextEncoder().encode('hello'));
    const b = buildSuiPersonalMessageDigest(new TextEncoder().encode('hello'));
    expect(a).toEqual(b);
  });

  it('different messages → different digests', () => {
    const a = buildSuiPersonalMessageDigest(new TextEncoder().encode('hello'));
    const b = buildSuiPersonalMessageDigest(new TextEncoder().encode('hello!'));
    expect(a).not.toEqual(b);
  });

  it('handles empty message without throwing', () => {
    const digest = buildSuiPersonalMessageDigest(new Uint8Array(0));
    expect(digest.length).toBe(32);
  });
});

describe('Mysten verifier accepts signatures over our digest', () => {
  it('round-trips: ed25519_sign(digest) → toSerializedSignature → verifyPersonalMessageSignature', async () => {
    const keypair = Ed25519Keypair.fromSecretKey(TEST_SECRET);
    const address = keypair.toSuiAddress();
    const pubkey = keypair.getPublicKey();

    const message = new TextEncoder().encode('paid alice for rent');
    const digest = buildSuiPersonalMessageDigest(message);

    // sign the digest with pure ed25519 (mirrors what ika MPC ed25519 does, over a 32-byte input)
    const sigBytes = await ed25519.sign(digest, TEST_SECRET);
    expect(sigBytes.length).toBe(64);

    const serialized = toSerializedSignature({
      signature: sigBytes,
      signatureScheme: 'ED25519',
      publicKey: new Ed25519PublicKey(pubkey.toRawBytes()),
    });

    // Mysten's verifier, re-derives the digest internally + ed25519-verifies
    const verifiedSig = await verifyPersonalMessageSignature(message, serialized, { address });
    expect(verifiedSig.toSuiAddress()).toBe(address);
  });

  it('rejects when the message is tampered', async () => {
    const keypair = Ed25519Keypair.fromSecretKey(TEST_SECRET);
    const address = keypair.toSuiAddress();
    const pubkey = keypair.getPublicKey();

    const message = new TextEncoder().encode('original message');
    const digest = buildSuiPersonalMessageDigest(message);
    const sigBytes = await ed25519.sign(digest, TEST_SECRET);
    const serialized = toSerializedSignature({
      signature: sigBytes,
      signatureScheme: 'ED25519',
      publicKey: new Ed25519PublicKey(pubkey.toRawBytes()),
    });

    const tampered = new TextEncoder().encode('original message!'); // extra char
    await expect(
      verifyPersonalMessageSignature(tampered, serialized, { address }),
    ).rejects.toThrow();
  });

  it('cross-checks our digest matches Mysten Ed25519Keypair.signPersonalMessage internally', async () => {
    // sign via Mysten's helper directly + via our pipeline, both should produce sigs that verify
    // against the SAME message under the SAME keypair. this proves byte-for-byte intent +
    // BCS + BLAKE2b parity with the Mysten SDK.
    const keypair = Ed25519Keypair.fromSecretKey(TEST_SECRET);
    const address = keypair.toSuiAddress();
    const pubkey = keypair.getPublicKey();

    const message = new TextEncoder().encode('cross-check sample');

    // path A: Mysten's helper end-to-end
    const mystenSig = await keypair.signPersonalMessage(message);
    const mystenVerified = await verifyPersonalMessageSignature(message, mystenSig.signature, {
      address,
    });
    expect(mystenVerified.toSuiAddress()).toBe(address);

    // path B: chromatika's digest helper + raw ed25519 + toSerializedSignature
    const digest = buildSuiPersonalMessageDigest(message);
    const sigBytes = await ed25519.sign(digest, TEST_SECRET);
    const ourSerialized = toSerializedSignature({
      signature: sigBytes,
      signatureScheme: 'ED25519',
      publicKey: new Ed25519PublicKey(pubkey.toRawBytes()),
    });
    const ourVerified = await verifyPersonalMessageSignature(message, ourSerialized, { address });
    expect(ourVerified.toSuiAddress()).toBe(address);

    // the two serialized signatures should match byte-for-byte (ed25519 is deterministic)
    expect(ourSerialized).toBe(mystenSig.signature);
  });
});
