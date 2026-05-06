# `EncryptionBackend` abstraction (`src/background/encryption/`)

a high-level, multi-backend interface for "encrypt arbitrary user data with the vault's master key." separate from `keyring/` (key derivation) and `crypto/` (low-level web crypto wrappers). lets activity notes, future encrypted contact book entries, and other user-data surfaces compose without each picking their own crypto stack. today only the `encrypt-xyz` backend is wired; `direct-ed25519` and `seal` are stubs that throw `not-implemented`.

## the interface

```ts
export interface EncryptionBackend {
  readonly id: string; // 'encrypt-xyz' | 'direct-ed25519' | 'seal'
  readonly capabilities: EncryptionBackendCapabilities;

  encryptForRecipient(plaintext: Uint8Array, recipient: RecipientId): Promise<EncryptedRef>;
  decrypt(ref: EncryptedRef): Promise<Uint8Array>;
}

export interface EncryptionBackendCapabilities {
  supportsCrossRecipient: boolean; // can encrypt to a different recipient
  supportsThresholdAccess: boolean; // threshold-of-N key servers (Seal)
  supportsInlineBody: boolean; // body fits inline without walrus blob storage
  maxInlinePlaintextBytes: number; // caller-enforced cap
}

export type RecipientId =
  | { kind: "self" } // active vault's own dWallet
  | { kind: "ed25519"; pubkey: Uint8Array } // cross-recipient via X25519 ECDH (stub)
  | { kind: "sui-address"; address: string }; // Seal Move policy (stub)

export type EncryptedRef =
  | { backend: "encrypt-xyz"; payload: EncryptXyzPayload; createdAtMs: number }
  | { backend: "direct-ed25519"; payload: DirectEd25519Payload; createdAtMs: number }
  | { backend: "seal"; payload: SealPayload; createdAtMs: number };
```

## the dispatch

`getEncryptionBackend(useCase: string)` returns the backend registered for a given use case. today:

```ts
const backendRegistry: Record<string, EncryptionBackend> = {
  "self-recipient-default": encryptXyzBackend,
  // future: 'cross-recipient-default': directEd25519Backend
  // future: 'threshold-policy-default': sealBackend
};
```

callers pass plaintext + a `RecipientId`, get back an `EncryptedRef`. they don't need to know which backend was used. the ref carries a backend tag so decrypt routes correctly:

```ts
async function decryptRefViaRegistry(ref: EncryptedRef): Promise<Uint8Array> {
  switch (ref.backend) {
    case "encrypt-xyz":
      return encryptXyzBackend.decrypt(ref);
    case "direct-ed25519":
      return directEd25519Backend.decrypt(ref); // stub
    case "seal":
      return sealBackend.decrypt(ref); // stub
  }
}
```

mixed-store tolerance: a single `chromatika_signed_txs_v1` could in principle hold notes encrypted under different backends (e.g. old encrypt-xyz refs from before, new direct-ed25519 refs after upgrade). decrypt dispatches per ref. no caller code changes.

## the `encrypt-xyz` backend

today's only implemented backend. uses encrypt.xyz pre-alpha gRPC for self-recipient encryption.

### `EncryptXyzPayload` shape

```ts
interface EncryptXyzPayload {
  bodyCiphertextB64: string; // AES-GCM ciphertext (no tag separation; webcrypto bundles)
  bodyIvB64: string; // 12-byte AES-GCM IV
  wrappedKeyCiphertextIdHexes: [string, string]; // two encrypt.xyz ciphertext-identifier hexes for the K halves
  recipientPubkeyB64: string; // 32-byte ed25519 pubkey of the recipient (active vault's dWallet)
  recipientLockedAtVaultId: string; // vault id at encryption time (used to detect "wrong vault" on decrypt)
  programIdB58: string; // encrypt program id used at encryption
  fheTypePerHalf: 5; // EUint128 (always)
}
```

### encrypt path

```ts
async function encryptXyzEncryptForRecipient(
  plaintext: Uint8Array,
  recipient: RecipientId
): Promise<EncryptedRef> {
  if (recipient.kind !== "self")
    throw new EncryptionBackendError({
      backend: "encrypt-xyz",
      reason: "unsupported-recipient",
      message: "only self-recipient supported in pre-alpha",
    });

  // 1. generate fresh 32-byte AES-256 key + 12-byte IV
  const K = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // 2. AES-GCM encrypt the body under K
  const aesKey = await crypto.subtle.importKey("raw", K, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext)
  );

  // 3. wrap K in two halves via encrypt.xyz CreateInput (single batched gRPC call)
  const halfA = K.slice(0, 16);
  const halfB = K.slice(16, 32);
  const inputs = [
    {
      ciphertextBytes: mockEncryptScalarBytesFromBytes(halfA, FHE_TYPE_EUINT128),
      fheType: FHE_TYPE_EUINT128,
    },
    {
      ciphertextBytes: mockEncryptScalarBytesFromBytes(halfB, FHE_TYPE_EUINT128),
      fheType: FHE_TYPE_EUINT128,
    },
  ];
  const { ciphertextIdentifiers } = await encryptXyzCreateInput(
    GRPC_URL,
    encodeCreateInputRequest({
      chain: 0,
      inputs,
      proof: new Uint8Array(),
      authorized: programId.toBytes(),
      networkEncryptionPublicKey: networkPubkey,
    })
  );
  if (ciphertextIdentifiers.length !== 2) throw "expected 2 identifiers";

  // 4. zero K
  K.fill(0);

  // 5. assemble the ref
  return {
    backend: "encrypt-xyz",
    payload: {
      bodyCiphertextB64: base64Encode(ciphertext),
      bodyIvB64: base64Encode(iv),
      wrappedKeyCiphertextIdHexes: [
        bytesToHex(ciphertextIdentifiers[0]),
        bytesToHex(ciphertextIdentifiers[1]),
      ],
      recipientPubkeyB64: base64Encode(activeDwalletEd25519Pubkey),
      recipientLockedAtVaultId: activeVaultId,
      programIdB58: programId.toBase58(),
      fheTypePerHalf: 5,
    },
    createdAtMs: Date.now(),
  };
}
```

key design choices:

- **K is per-encrypt random**, not derived from any persistent secret. each note has its own AES key. compromise of one K doesn't compromise others
- **two halves via EUint128**: encrypt.xyz EUint128 fits 16 bytes. AES-256 needs 32. split + wrap two halves; same gRPC round-trip
- **`recipientLockedAtVaultId`**: persists which vault was active at encryption time. on decrypt, validates the active vault id still matches - prevents accidentally trying to decrypt vault A's note while vault B is active

### decrypt path

```ts
async function encryptXyzDecrypt(ref: EncryptedRef): Promise<Uint8Array> {
  if (ref.backend !== "encrypt-xyz") throw "wrong backend";
  const { payload } = ref;

  // 1. validate active vault matches what was active at encryption time
  if (sessionState.activeVaultId !== payload.recipientLockedAtVaultId) {
    throw new EncryptionBackendError({
      backend: "encrypt-xyz",
      reason: "wrong-vault",
      message: "active vault changed; switch to " + payload.recipientLockedAtVaultId,
    });
  }
  const activePubkey = await getDwalletEd25519PublicKey();
  if (base64Encode(activePubkey) !== payload.recipientPubkeyB64) {
    throw new EncryptionBackendError({
      backend: "encrypt-xyz",
      reason: "wrong-vault",
      message: "dWallet pubkey mismatch",
    });
  }

  // 2. unwrap K via two sequential ReadCiphertext gRPC calls (signed)
  const halfA = await unwrapEncryptHalfWithSignedRead(payload.wrappedKeyCiphertextIdHexes[0]);
  const halfB = await unwrapEncryptHalfWithSignedRead(payload.wrappedKeyCiphertextIdHexes[1]);
  const K = new Uint8Array(32);
  K.set(halfA, 0);
  K.set(halfB, 16);

  // 3. AES-GCM decrypt the body
  const aesKey = await crypto.subtle.importKey("raw", K, { name: "AES-GCM" }, false, ["decrypt"]);
  const ciphertext = base64Decode(payload.bodyCiphertextB64);
  const iv = base64Decode(payload.bodyIvB64);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext)
  );

  // 4. zero K
  K.fill(0);

  return plaintext;
}
```

`unwrapEncryptHalfWithSignedRead(idHex)` is what costs the user MPC fees:

1. encode `ReadCiphertextMessage` BCS-style (chain=0, ciphertext id, empty rekey, epoch=0)
2. ika MPC ED25519 signs the message via `signMessageSol`
3. sends `ReadCiphertext` gRPC request with the signed message
4. returns the 16-byte decrypted half

**two MPC signs** per decrypt (one per K half). that's the source of the 1-3s decrypt latency.

## the `EncryptionBackendError` class

structured errors for callers to render specific UI:

```ts
class EncryptionBackendError extends Error {
  constructor(public info: { backend: string; reason: string; message: string }) {
    super(info.message);
  }
}

// reasons:
// 'wrong-vault'        - active vault doesn't match the recipient's vault
// 'wrong-recipient'    - active dWallet's pubkey doesn't match recipientPubkeyB64
// 'devnet-wipe'        - encrypt.xyz on-chain ciphertext is gone (devnet wiped)
// 'not-implemented'    - this backend isn't wired yet (direct-ed25519, seal)
// 'unsupported-recipient' - this backend doesn't support the recipient kind
// 'gRPC error'         - encrypt.xyz gRPC failed (network, auth, etc.)
// 'aes-gcm-fail'       - AES-GCM auth tag failed (corrupted ciphertext)
```

UI catches and shows specific copy: `wrong-vault` → "switch to vault X to read this note", `devnet-wipe` → "this note's on-chain ciphertext was lost in a devnet wipe; clear and re-encrypt".

## the future stubs

### `direct-ed25519` (cross-recipient via X25519 ECDH)

```ts
const directEd25519Backend: EncryptionBackend = {
  id: "direct-ed25519",
  capabilities: {
    supportsCrossRecipient: true,
    supportsThresholdAccess: false,
    supportsInlineBody: true,
    maxInlinePlaintextBytes: 8192,
  },
  async encryptForRecipient(_plaintext, _recipient) {
    throw new EncryptionBackendError({
      backend: "direct-ed25519",
      reason: "not-implemented",
      message: "X25519 ECDH path not wired yet",
    });
  },
  async decrypt(_ref) {
    throw new EncryptionBackendError({
      backend: "direct-ed25519",
      reason: "not-implemented",
      message: "X25519 ECDH path not wired yet",
    });
  },
};
```

would do: convert recipient's ed25519 pubkey to X25519, perform ECDH with caller's X25519 key, derive AES key, encrypt body. recipient does the symmetric ECDH on their side. cross-recipient without on-chain dependencies.

### `seal` (Sui Move policy via Mysten's Seal package)

threshold-of-N key servers + Move-based policy enforcement (e.g. "decrypt only allowed if the requester owns dWallet X" or "decrypt only after epoch Y"). powerful but heavyweight; needs Seal SDK + Sui RPC. tracked future.

## library

- internal: `src/background/encryption/types.ts` for the interface + types
- internal: `src/background/encryption/encrypt-xyz-backend.ts` for the encrypt-xyz impl
- internal: `src/background/encryption/registry.ts` for `getEncryptionBackend`, `decryptRefViaRegistry`
- internal: `src/background/encrypt/encrypt-lab-service.ts` for `mockEncryptScalarBytesFromBytes`, `encryptXyzCreateInput`, gRPC plumbing
- `crypto.subtle` for AES-GCM
- `crypto.getRandomValues` for K + IV generation

## related

- [activity-notes-encrypt-decrypt.md](/library/tech/activity-notes-encrypt-decrypt) - the activity-notes use case that drives this abstraction
- [signed-tx-record.md](/library/tech/signed-tx-record) - the `EncryptedRef` storage location
- [encrypt-create-input.md](/library/tech/encrypt-create-input) - the encrypt.xyz wrap layer
- [encrypt-read-ciphertext-signed.md](/library/tech/encrypt-read-ciphertext-signed) - the encrypt.xyz unwrap layer
