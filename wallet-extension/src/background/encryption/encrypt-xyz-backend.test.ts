/**
 * round-trip tests for EncryptXyzBackend. the gRPC + signing surfaces are mocked - we want to
 * exercise the envelope logic (random K, AES-GCM body, K chunking, dispatch) without spinning up
 * a real encrypt.xyz devnet executor.
 *
 * coverage:
 *   1. self-recipient encrypt + decrypt round-trip preserves the plaintext bytes
 *   2. cross-recipient encrypt throws EncryptionBackendError(reason='unsupported-recipient')
 *   3. oversized plaintext throws EncryptionBackendError(reason='protocol-error')
 *   4. decrypt with mismatched active-vault recipient throws (reason='wrong-vault')
 *   5. K chunking: chunk0 || chunk1 reassembled equals the original 32-byte K
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EncryptionBackendError } from '@/background/encryption/types';

// mock all external surfaces BEFORE importing the backend so the imports pick up the mocks.
const wireMocks = vi.hoisted(() => ({
  encryptGrpcCreateInput: vi.fn<(...a: unknown[]) => Promise<Uint8Array>>(),
  encryptGrpcReadCiphertext: vi.fn<(...a: unknown[]) => Promise<Uint8Array>>(),
  encodeCreateInputRequest: vi.fn(),
  decodeCreateInputResponse: vi.fn(),
  encodeReadCiphertextRequest: vi.fn(),
  decodeReadCiphertextResponse: vi.fn(),
  encodeReadCiphertextMessage: vi.fn(),
  signMessageSol: vi.fn<(...a: unknown[]) => Promise<{ signature: string }>>(),
  getDwalletEd25519PublicKey: vi.fn<(...a: unknown[]) => Promise<Uint8Array>>(),
  labConnection: vi.fn(),
  resolveNetworkEncryptionPublicKey: vi.fn<(...a: unknown[]) => Promise<Uint8Array>>(),
}));

vi.mock('@/background/encrypt/encrypt-grpc-web-fetch', () => ({
  encryptGrpcCreateInput: wireMocks.encryptGrpcCreateInput,
  encryptGrpcReadCiphertext: wireMocks.encryptGrpcReadCiphertext,
}));

vi.mock('@/background/encrypt/encrypt-protobuf-wire', () => ({
  encodeCreateInputRequest: wireMocks.encodeCreateInputRequest,
  decodeCreateInputResponse: wireMocks.decodeCreateInputResponse,
  encodeReadCiphertextRequest: wireMocks.encodeReadCiphertextRequest,
  decodeReadCiphertextResponse: wireMocks.decodeReadCiphertextResponse,
}));

vi.mock('@/background/encrypt/encrypt-read-msg', () => ({
  encodeReadCiphertextMessage: wireMocks.encodeReadCiphertextMessage,
}));

vi.mock('@/background/chains/signing', () => ({
  signMessageSol: wireMocks.signMessageSol,
}));

vi.mock('@/background/chains/solana', () => ({
  getDwalletEd25519PublicKey: wireMocks.getDwalletEd25519PublicKey,
}));

vi.mock('@/background/encrypt/encrypt-lab-service', async () => {
  // keep the small pure helpers (bytesLeToBigInt, hex, hexToBytes, FHE_TYPE_EUINT128,
  // signatureHexToEd25519Bytes) live - they have no side effects. stub the session-touching
  // `labConnection` and `resolveNetworkEncryptionPublicKey`.
  const real = await vi.importActual<typeof import('@/background/encrypt/encrypt-lab-service')>(
    '@/background/encrypt/encrypt-lab-service',
  );
  return {
    ...real,
    labConnection: wireMocks.labConnection,
    resolveNetworkEncryptionPublicKey: wireMocks.resolveNetworkEncryptionPublicKey,
  };
});

import { encryptXyzBackend } from '@/background/encryption/encrypt-xyz-backend';

// shared K-chunk store: when the backend "wraps" K via CreateInput, the mock records the chunks
// keyed by their identifier hex. ReadCiphertext mocks read back from this store.
const chunkStore = new Map<string, Uint8Array>();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

beforeEach(() => {
  chunkStore.clear();

  // active vault dWallet ed25519 pubkey (32 zero bytes by default; tests override per case).
  wireMocks.getDwalletEd25519PublicKey.mockResolvedValue(new Uint8Array(32));

  // network helpers - opaque blobs, the backend just passes them through.
  wireMocks.labConnection.mockReturnValue({});
  wireMocks.resolveNetworkEncryptionPublicKey.mockResolvedValue(new Uint8Array(32));

  // encodeCreateInputRequest captures the chunks it's asked to wrap (so the read mock can see them).
  wireMocks.encodeCreateInputRequest.mockImplementation(
    (req: { inputs: Array<{ ciphertextBytes: Uint8Array }> }) => {
      // ciphertext bytes are 17 bytes: [fhe_type(1) || value_le(16)]. strip the leading type byte.
      const chunks = req.inputs.map((i) => i.ciphertextBytes.slice(1, 17));
      return { __chunks: chunks } as unknown as Uint8Array;
    },
  );

  // encryptGrpcCreateInput pretends to ship the request and ship back a response wrapping the
  // chunks. the response payload is opaque - we just ferry it to decodeCreateInputResponse.
  wireMocks.encryptGrpcCreateInput.mockImplementation(async (_base, req) => {
    return req as unknown as Uint8Array;
  });

  // decodeCreateInputResponse mints fake ciphertext identifier bytes and stores the original
  // K chunks so the read path can recover them.
  wireMocks.decodeCreateInputResponse.mockImplementation((res: unknown) => {
    const captured = res as { __chunks: Uint8Array[] };
    const ids = captured.__chunks.map((chunk, i) => {
      const id = new Uint8Array(32);
      id[0] = i + 1; // distinct ids per chunk
      const hex = bytesToHex(id);
      chunkStore.set(hex, chunk);
      return id;
    });
    return { ciphertextIdentifiers: ids };
  });

  // encodeReadCiphertextMessage / encodeReadCiphertextRequest: opaque ferry. shape is
  // `{ __ct: Uint8Array }` so the gRPC mock can pull the identifier back out.
  wireMocks.encodeReadCiphertextMessage.mockImplementation((_chain, ct: Uint8Array) => {
    return { __ct: ct } as unknown as Uint8Array;
  });
  wireMocks.encodeReadCiphertextRequest.mockImplementation(
    (req: { message: { __ct: Uint8Array } }) => {
      return { __ct: req.message.__ct } as unknown as Uint8Array;
    },
  );

  // signMessageSol returns a 64-byte hex signature. the actual sig value doesn't matter for the
  // mock - only the shape (128-char hex) is checked downstream by signatureHexToEd25519Bytes.
  wireMocks.signMessageSol.mockResolvedValue({ signature: 'a'.repeat(128) });

  // encryptGrpcReadCiphertext: look up the ciphertext id in the chunk store and return the K chunk.
  wireMocks.encryptGrpcReadCiphertext.mockImplementation(async (_base, req) => {
    const captured = req as unknown as { __ct: Uint8Array };
    return { __ct: captured.__ct } as unknown as Uint8Array;
  });

  // decodeReadCiphertextResponse: pull the chunk out of the chunk store using the request's id.
  wireMocks.decodeReadCiphertextResponse.mockImplementation((res: unknown) => {
    const captured = res as { __ct: Uint8Array };
    const idHex = bytesToHex(captured.__ct);
    const chunk = chunkStore.get(idHex);
    if (!chunk) {
      throw new Error(`mock: no chunk for id ${idHex}`);
    }
    return {
      value: chunk,
      fheType: 5,
      digest: new Uint8Array(32),
    };
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('EncryptXyzBackend', () => {
  describe('id + capabilities', () => {
    it('reports id "encrypt-xyz" and self-recipient-only capabilities', () => {
      expect(encryptXyzBackend.id).toBe('encrypt-xyz');
      expect(encryptXyzBackend.capabilities.supportsCrossRecipient).toBe(false);
      expect(encryptXyzBackend.capabilities.supportsThresholdAccess).toBe(false);
      expect(encryptXyzBackend.capabilities.supportsInlineBody).toBe(true);
      expect(encryptXyzBackend.capabilities.maxInlinePlaintextBytes).toBeGreaterThan(0);
    });
  });

  describe('encryptForRecipient', () => {
    it('encrypts to self and returns an encrypt-xyz tagged ref with 2 wrapped key chunks', async () => {
      const plaintext = new TextEncoder().encode('paid alice for rent');
      const ref = await encryptXyzBackend.encryptForRecipient(plaintext, { kind: 'self' });

      expect(ref.backend).toBe('encrypt-xyz');
      expect(ref.createdAtMs).toBeGreaterThan(0);
      if (ref.backend !== 'encrypt-xyz') throw new Error('type narrow');
      expect(ref.payload.wrappedKeyCiphertextIdHexes).toHaveLength(2);
      expect(typeof ref.payload.bodyCiphertextB64).toBe('string');
      expect(typeof ref.payload.bodyIvB64).toBe('string');
      expect(ref.payload.chain).toBe(0);
      expect(ref.payload.recipientPubkeyB64.length).toBeGreaterThan(0);
      expect(wireMocks.encryptGrpcCreateInput).toHaveBeenCalledTimes(1); // single batched round-trip
    });

    it('throws unsupported-recipient on cross-recipient encrypt', async () => {
      const plaintext = new TextEncoder().encode('drain report');
      const recipient = { kind: 'ed25519' as const, pubkey: new Uint8Array(32) };
      await expect(encryptXyzBackend.encryptForRecipient(plaintext, recipient)).rejects.toThrow(
        EncryptionBackendError,
      );
      try {
        await encryptXyzBackend.encryptForRecipient(plaintext, recipient);
      } catch (e) {
        expect(e).toBeInstanceOf(EncryptionBackendError);
        if (e instanceof EncryptionBackendError) {
          expect(e.reason).toBe('unsupported-recipient');
          expect(e.backend).toBe('encrypt-xyz');
        }
      }
    });

    it('throws protocol-error on plaintext exceeding the inline cap', async () => {
      const tooBig = new Uint8Array(encryptXyzBackend.capabilities.maxInlinePlaintextBytes + 1);
      await expect(encryptXyzBackend.encryptForRecipient(tooBig, { kind: 'self' })).rejects.toThrow(
        EncryptionBackendError,
      );
    });
  });

  describe('decrypt (round-trip)', () => {
    it('round-trips plaintext for the same active-vault recipient', async () => {
      const plaintext = new TextEncoder().encode('coffee for the team');
      const ref = await encryptXyzBackend.encryptForRecipient(plaintext, { kind: 'self' });
      const recovered = await encryptXyzBackend.decrypt(ref);
      expect(new TextDecoder().decode(recovered)).toBe('coffee for the team');
      // two ReadCiphertext calls (one per K chunk).
      expect(wireMocks.encryptGrpcReadCiphertext).toHaveBeenCalledTimes(2);
    });

    it('round-trips utf-8 multibyte and binary payloads', async () => {
      const utf8 = new TextEncoder().encode('🦀 安全な暗号化 🔐');
      const refUtf8 = await encryptXyzBackend.encryptForRecipient(utf8, { kind: 'self' });
      const recoveredUtf8 = await encryptXyzBackend.decrypt(refUtf8);
      expect(new TextDecoder().decode(recoveredUtf8)).toBe('🦀 安全な暗号化 🔐');

      const binary = crypto.getRandomValues(new Uint8Array(2048));
      const refBin = await encryptXyzBackend.encryptForRecipient(binary, { kind: 'self' });
      const recoveredBin = await encryptXyzBackend.decrypt(refBin);
      expect(recoveredBin).toEqual(binary);
    });

    it('throws wrong-vault when active vault changes between encrypt and decrypt', async () => {
      const plaintext = new TextEncoder().encode('switch vaults mid-flight');
      // encrypt as vault A (zero-byte pubkey).
      const ref = await encryptXyzBackend.encryptForRecipient(plaintext, { kind: 'self' });
      // switch active vault to a different ed25519 pubkey.
      const otherPubkey = new Uint8Array(32);
      otherPubkey[0] = 0xff;
      wireMocks.getDwalletEd25519PublicKey.mockResolvedValue(otherPubkey);
      await expect(encryptXyzBackend.decrypt(ref)).rejects.toThrow(EncryptionBackendError);
      try {
        await encryptXyzBackend.decrypt(ref);
      } catch (e) {
        if (e instanceof EncryptionBackendError) {
          expect(e.reason).toBe('wrong-vault');
        }
      }
    });

    it('rejects refs from other backends', async () => {
      await expect(
        encryptXyzBackend.decrypt({
          backend: 'direct-ed25519',
          payload: {
            ephemeralPubkeyB64: 'a',
            bodyCiphertextB64: 'b',
            bodyIvB64: 'c',
            recipientPubkeyB64: 'd',
          },
          createdAtMs: 0,
        }),
      ).rejects.toThrow(EncryptionBackendError);
    });
  });

  describe('K chunking', () => {
    it('uses two distinct EUint128 chunks (16 bytes each) covering the full 32-byte K', async () => {
      const plaintext = new Uint8Array([1, 2, 3, 4]);
      await encryptXyzBackend.encryptForRecipient(plaintext, { kind: 'self' });

      // inspect the captured chunks from the chunkStore - they should reassemble to 32 bytes,
      // and the two chunk ids should be distinct.
      const ids = [...chunkStore.keys()];
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);

      const c0 = chunkStore.get(ids[0]!)!;
      const c1 = chunkStore.get(ids[1]!)!;
      expect(c0.length).toBe(16);
      expect(c1.length).toBe(16);
      // K is random per encrypt, but the chunks should not be all-zero.
      const allZero = (b: Uint8Array) => b.every((x) => x === 0);
      expect(allZero(c0) && allZero(c1)).toBe(false);
    });
  });
});
