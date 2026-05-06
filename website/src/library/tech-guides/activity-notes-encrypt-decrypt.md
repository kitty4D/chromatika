# activity notes encrypt + decrypt flows

per-tx encrypted user notes. plaintext up to 2048 utf-8 bytes. encrypted via the `EncryptionBackend` abstraction (today: `encrypt-xyz` backend, self-recipient only). the encrypted ref persists on the local `SignedTxRecord` at `chromatika_signed_txs_v1`. tRPC procedures: `encryptActivityNote`, `decryptActivityNote`, `removeActivityNote`, `getActivityNoteStatus`.

## the four tRPC procedures

```ts
// router: src/server/routers/activity-notes.ts

// encrypt + attach to an existing tx record
encryptActivityNote: mutation
  input: { txHash: string, plaintext: string }   // plaintext.min(1).max-utf8(2048)
  output: { ok: true, backend: string, createdAtMs: number }
  errors: 'no-record' | 'plaintext-empty' | 'plaintext-too-long' | EncryptionBackendError

// decrypt (mutation despite read-shape because MPC sign is required)
decryptActivityNote: mutation
  input: { txHash: string }
  output:
    | { plaintext: string, status: 'ok' }
    | { plaintext: null, status: 'none' }              // record exists, no note attached
    | { plaintext: null, status: 'error', errorReason: string, errorMessage: string }

// drop the encrypted ref (idempotent)
removeActivityNote: mutation
  input: { txHash: string }
  output: { ok: true, removed: boolean }

// presence check, no decrypt cost
getActivityNoteStatus: query
  input: { txHash: string }
  output:
    | { hasRecord: false, hasNote: false }
    | { hasRecord: true, hasNote: false, backend: null, createdAtMs: null, origin: string | null, kind: string }
    | { hasRecord: true, hasNote: true, backend: string, createdAtMs: number, origin: string | null, kind: string }
```

router mounted in `src/server/router.ts` line 37 via `...activityNotesProcedures`.

## the encrypt flow

```
1. tRPC encryptActivityNote({ txHash, plaintext })

2. fetch the local SignedTxRecord
   const rec = await getSignedTxByHash(txHash, sessionState.activeVaultId);
   if (!rec) throw 'no-record';

3. validate plaintext
   const utf8 = new TextEncoder().encode(plaintext);
   if (utf8.length === 0) throw 'plaintext-empty';
   if (utf8.length > 2048) throw 'plaintext-too-long';

4. resolve backend
   const backend = getEncryptionBackend('self-recipient-default');
   // → encryptXyzBackend (today)

5. encrypt via the backend
   const ref = await backend.encryptForRecipient(utf8, { kind: 'self' });
   // backend internally:
   //   a. generates K (32 random bytes), iv (12 random bytes)
   //   b. AES-GCM encrypts utf8 with K + iv
   //   c. splits K into halfA (16 bytes) + halfB (16 bytes)
   //   d. mock-encrypts each half to 17-byte canonical (FHE_TYPE_EUINT128 || halfBytesLE16)
   //   e. encrypt.xyz CreateInput batched call (one gRPC, two inputs)
   //   f. returns ref = {
   //        backend: 'encrypt-xyz',
   //        payload: {
   //          bodyCiphertextB64, bodyIvB64,
   //          wrappedKeyCiphertextIdHexes: [hexA, hexB],
   //          recipientPubkeyB64: base64Encode(activeDwalletEd25519Pubkey),
   //          recipientLockedAtVaultId: activeVaultId,
   //          programIdB58, fheTypePerHalf: 5,
   //        },
   //        createdAtMs: Date.now(),
   //      }
   //   g. zeroes K

6. patch the record
   await updateSignedTxNote(txHash, sessionState.activeVaultId, ref);

7. return { ok: true, backend: 'encrypt-xyz', createdAtMs: ref.createdAtMs }
```

cost: one MPC `approve_message` gRPC call (the encrypt.xyz `CreateInput` carries an `approve_message` from the in-extension fee-payer keypair). milliseconds + tiny SOL fee.

note: encrypt **doesn't** need an ika MPC sign. only the network's `approve_message` (signed by the in-extension fee-payer keypair, no ika round-trip). that's why encrypt is fast (~500ms) while decrypt is slow (~1-3s).

## the decrypt flow

```
1. tRPC decryptActivityNote({ txHash })

2. fetch the local SignedTxRecord
   const rec = await getSignedTxByHash(txHash, sessionState.activeVaultId);
   if (!rec) return { plaintext: null, status: 'none' };
   if (!rec.encryptedNote) return { plaintext: null, status: 'none' };
   const ref = rec.encryptedNote;

3. dispatch by backend
   try {
     const plaintext = await decryptRefViaRegistry(ref);
     // for encrypt-xyz, this:
     //   a. validates activeVaultId === ref.payload.recipientLockedAtVaultId
     //      throws 'wrong-vault' if not
     //   b. validates active dWallet ed25519 pubkey === ref.payload.recipientPubkeyB64
     //      throws 'wrong-vault' if not
     //   c. for each of the two wrappedKeyCiphertextIdHexes:
     //      - encodeReadCiphertextMessage(0, idBytes, empty, 0n)  // BCS layout
     //      - signMessageSol(message)  // ika MPC ED25519 sign
     //      - encryptGrpcReadCiphertext(GRPC_URL, encodeReadCiphertextRequest({
     //          message, signature: sigBytes, signer: pubkeyBytes
     //        }))
     //      - decode response, extract 16-byte plaintext value (the AES key half)
     //   d. concat halfA + halfB → K (32 bytes)
     //   e. importKey('raw', K, AES-GCM, non-extractable, ['decrypt'])
     //   f. AES-GCM decrypt body with K + iv
     //   g. zero K
     //   h. return plaintext bytes

     return { plaintext: new TextDecoder('utf-8', { fatal: false }).decode(plaintext), status: 'ok' };
   } catch (e: any) {
     if (e instanceof EncryptionBackendError) {
       return { plaintext: null, status: 'error', errorReason: e.info.reason, errorMessage: e.info.message };
     }
     return { plaintext: null, status: 'error', errorReason: 'unknown', errorMessage: String(e) };
   }
```

cost: **two ika MPC ED25519 signs** + two encrypt.xyz `ReadCiphertext` gRPC calls. each MPC sign consumes one ED25519_EDDSA presign. total 1-3 seconds on devnet.

the two reads are **sequential**, not parallel. could in principle parallelize (each is independent gRPC), but pre-alpha encrypt.xyz throughput is fine and keeping the code linear is simpler.

## why decrypt is a mutation

tRPC convention: queries are read-only (no side effects). decrypt **costs a presign** (consumes signing material), so it's effectively a state-mutating operation. classifying as `mutation` lets the tRPC client cache differently and prevents accidental retry loops on UI re-render.

## the remove flow

```
1. tRPC removeActivityNote({ txHash })
2. const removed = await updateSignedTxNote(txHash, sessionState.activeVaultId, null);
3. return { ok: true, removed }
```

drops the `encryptedNote` field from the record. no on-chain action - the encrypt.xyz ciphertext stays on chain (and may eventually expire / get wiped on devnet).

idempotent: removing an already-removed note returns `{ ok: true, removed: false }`. safe to call without checking.

## the presence-check (`getActivityNoteStatus`)

lightweight query, no decrypt. used by:

- the activity feed merge to set `item.hasEncryptedNote`
- the note-edit modal to know "should I show 'view' or '+ note'"
- any UI that wants to reflect note presence without paying decrypt cost

```ts
async function getActivityNoteStatus({ txHash }): Promise<...> {
  const rec = await getSignedTxByHash(txHash, sessionState.activeVaultId);
  if (!rec) return { hasRecord: false, hasNote: false };
  if (!rec.encryptedNote) return {
    hasRecord: true, hasNote: false,
    backend: null, createdAtMs: null,
    origin: rec.origin, kind: rec.kind,
  };
  return {
    hasRecord: true, hasNote: true,
    backend: rec.encryptedNote.backend,
    createdAtMs: rec.encryptedNote.createdAtMs,
    origin: rec.origin, kind: rec.kind,
  };
}
```

returns the `origin` + `kind` fields too, since the UI often wants those alongside the note status (e.g. "this is a uniswap.org swap with a note attached").

## the UI integration

`src/ui/components/NoteEditModal.tsx`:

three states based on note presence + decrypt outcome:

- **no note yet** (or user clicked edit): textarea with "encrypt + save" button + utf-8 byte counter
- **note locked**: "decrypt to view" + "remove" buttons; pre-alpha disclaimer
- **note decrypted**: read-only plaintext display + "edit" + "remove" buttons

modal opens on click of "+ note" or "view note" buttons in `ActivityPage.tsx`. on mount, calls `getActivityNoteStatus` (lightweight). user-triggered actions call `encryptActivityNote` / `decryptActivityNote` / `removeActivityNote`.

`src/ui/components/EncryptedNoteBadge.tsx`:

lock icon (12px) rendered inline next to the tx label in the activity feed. visible only when `item.hasEncryptedNote === true`. purely visual; click handler is on the parent activity row.

## error handling

`EncryptionBackendError` reasons surface specifically:

- `wrong-vault` - "switch to <recipientLockedAtVaultId> to read this note"
- `not-implemented` - shouldn't happen for encrypt-xyz (only stubs throw this)
- `aes-gcm-fail` - "this note's ciphertext is corrupted; try removing + re-encrypting"
- `gRPC error` - "encrypt.xyz unavailable; try again"
- `devnet-wipe` - "this note's on-chain ciphertext was lost in a devnet wipe; clear + re-encrypt"

the UI maps these to specific copy strings rather than showing raw error.message.

## the pre-alpha disclaimer obligation

every note surface (modal, badge tooltip, settings copy) must include the encrypt.xyz pre-alpha disclaimer. ciphertexts may be plaintext on-chain in this phase. treat as **dev preview**, not production secrecy. do not put real secrets in notes.

## library

- internal: `src/server/routers/activity-notes.ts` for the four tRPC procedures
- internal: `src/background/services/tx-record.ts` for `getSignedTxByHash`, `updateSignedTxNote`
- internal: `src/background/encryption/registry.ts` for `getEncryptionBackend`, `decryptRefViaRegistry`
- internal: `src/background/encryption/encrypt-xyz-backend.ts` for the backend impl
- internal: `src/ui/components/NoteEditModal.tsx`, `EncryptedNoteBadge.tsx`

## related

- [signed-tx-record.md](/library/tech/signed-tx-record) - the `SignedTxRecord` store + `EncryptedRef` location
- [encryption-backend-abstraction.md](/library/tech/encryption-backend-abstraction) - the backend interface
- [encrypt-create-input.md](/library/tech/encrypt-create-input) - encrypt.xyz wrap layer (used by encrypt path)
- [encrypt-read-ciphertext-signed.md](/library/tech/encrypt-read-ciphertext-signed) - encrypt.xyz unwrap layer (used by decrypt path)
- [activity-notes.md](/library/user/activity-notes) (user-guides) - the user-facing flow
