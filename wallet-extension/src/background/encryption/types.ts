/**
 * EncryptionBackend interface - abstracts the per-use-case choice between encrypt.xyz, Seal,
 * and direct-ed25519 (X25519-from-ed25519) ECDH for self-recipient and cross-recipient envelopes.
 *
 * why this exists: chromatika has multiple encryption surfaces with different needs.
 *   - encrypted dWallet labels (encrypt.xyz today, self-recipient)
 *   - encrypted activity notes (encrypt.xyz, self-recipient - first consumer of this interface)
 *   - encrypted vault backup (encrypt.xyz envelope + walrus body, self-recipient - future)
 *   - drain reports (cross-recipient: chromatika team's dWallet - future, blocked by encrypt.xyz pre-alpha gap)
 *   - gift envelopes (cross-recipient: arbitrary user - future, same gap)
 *   - nft-gated media (sui Move policy - Seal, future)
 *
 * the prereq spike confirmed encrypt.xyz pre-alpha does not support cross-recipient encryption
 * today (CreateInput has no recipient field; ReadCiphertext returns plaintext to the signer
 * only). so this interface ships with two real backends + one stub:
 *   - EncryptXyzBackend: default for self-recipient cases. wraps a random AES key
 *     via 2× EUint128 chunks and encrypts the body with AES-GCM under that key. the body
 *     ciphertext is returned as a base64 blob for the caller to persist (locally, or on walrus
 *     when that ships).
 *   - DirectEd25519Backend: stub. cross-recipient via X25519 ECDH derived from ed25519 keys
 *     (Tweetnacl-style sealed box) is the planned fallback until encrypt.xyz lands recipient-keyed.
 *     throws on call today; design and impl are deferred to a future slice.
 *   - SealBackend: not implemented in this slice. blocked on chromatika's sui_signPersonalMessage
 *     using SHA-512 instead of Mysten BLAKE2b PersonalMessage intent (see WALLET_SECURITY.md).
 *
 * see `wallet-extension/docs/ENCRYPTION_BACKEND.md` for the per-use-case decision matrix.
 */

/** identifier for a recipient. cross-recipient kinds will fail on EncryptXyzBackend until pre-alpha lands recipient-keyed. */
export type RecipientId =
  /** active vault's own dWallet (encrypt-to-self). the only kind EncryptXyzBackend supports today. */
  | { kind: 'self' }
  /** a specific ed25519 pubkey (cross-recipient). for drain reports / gift envelopes - uses DirectEd25519Backend. */
  | { kind: 'ed25519'; pubkey: Uint8Array }
  /** a specific sui address (cross-recipient via Seal Move policy). for nft-gated media - uses SealBackend (future). */
  | { kind: 'sui-address'; address: string };

/**
 * EncryptXyzBackend payload. held by the caller and passed back to `decrypt`. the body
 * ciphertext is returned to the caller because tier-3 use cases store it in different places
 * (chrome.storage for activity notes, walrus for vault backup, solana account for x402 receipts).
 *
 * the 2× EUint128 chunking pattern matches the existing dWallet labels feature
 * (see encrypt-lab-service.ts), giving a 32-byte AES-256 key in two CreateInput identifiers.
 */
export interface EncryptXyzPayload {
  /**
   * the 2 ciphertext_identifier hexes from the encrypt.xyz CreateInput response. each one wraps
   * 16 bytes of the AES key K (`K = chunk0 || chunk1`). read via gRPC ReadCiphertext using
   * `signMessageSol` on the recipient's dWallet ed25519 key.
   */
  wrappedKeyCiphertextIdHexes: [string, string];
  /** AES-GCM 256 ciphertext of the body (base64). caller persists this however fits the use case. */
  bodyCiphertextB64: string;
  /** AES-GCM 12-byte iv (base64). random per encryption - callers MUST NOT reuse iv across writes. */
  bodyIvB64: string;
  /**
   * the dWallet ed25519 pubkey that can call ReadCiphertext to unwrap K. for `kind: 'self'` this
   * is the active vault's own dWallet ed25519 pubkey at encrypt time. decrypt asserts the active
   * vault still matches before triggering an ika sign that would otherwise fail with a confusing
   * downstream error.
   */
  recipientPubkeyB64: string;
  /** encrypt.xyz `chain` field (see CreateInputRequest). currently always 0 for solana devnet. */
  chain: number;
  /** encrypt.xyz program id (base58) at encrypt time. used to detect program rotation on devnet wipes. */
  programId: string;
}

/** DirectEd25519Backend payload. stub today - populated when X25519-from-ed25519 ships. */
export interface DirectEd25519Payload {
  /** ephemeral X25519 pubkey (base64) the recipient combines with their privkey to derive K. */
  ephemeralPubkeyB64: string;
  /** AES-GCM 256 ciphertext of the body (base64). */
  bodyCiphertextB64: string;
  /** AES-GCM 12-byte iv (base64). */
  bodyIvB64: string;
  /** recipient's ed25519 pubkey (base64). the recipient's ed25519 privkey is converted to X25519 to unwrap. */
  recipientPubkeyB64: string;
}

/** SealBackend payload. not implemented in this slice. */
export interface SealPayload {
  sealCiphertextB64: string;
  packageId: string;
  identityB64: string;
}

/**
 * backend-tagged ciphertext reference. persisted as JSON in tx-records / per-vault meta /
 * walrus pointers. `backend` field tells the registry which backend to dispatch to on decrypt.
 */
export type EncryptedRef =
  | { backend: 'encrypt-xyz'; payload: EncryptXyzPayload; createdAtMs: number }
  | { backend: 'direct-ed25519'; payload: DirectEd25519Payload; createdAtMs: number }
  | { backend: 'seal'; payload: SealPayload; createdAtMs: number };

export type EncryptionBackendId = EncryptedRef['backend'];

export interface EncryptionBackendCapabilities {
  /** can encrypt to a recipient who is not the creator. false for encrypt.xyz pre-alpha. */
  supportsCrossRecipient: boolean;
  /** threshold-of-N key servers (Seal). false for encrypt.xyz and direct-ed25519. */
  supportsThresholdAccess: boolean;
  /**
   * body fits inline in an on-chain account (e.g. activity note in tx-record) without external
   * blob storage. false once we want >~8KB payloads - at which point the caller pairs the
   * backend with a walrus client to store the body off-chain.
   */
  supportsInlineBody: boolean;
  /** caller-enforced cap on plaintext bytes. notes-style use cases stay well under 8KB. */
  maxInlinePlaintextBytes: number;
}

export interface EncryptionBackend {
  readonly id: EncryptionBackendId;
  readonly capabilities: EncryptionBackendCapabilities;
  /**
   * encrypt `plaintext` to `recipient`. throws `EncryptionBackendError` with a human-readable
   * message if the recipient kind is unsupported by this backend (e.g. encrypt-xyz pre-alpha
   * cross-recipient).
   */
  encryptForRecipient(plaintext: Uint8Array, recipient: RecipientId): Promise<EncryptedRef>;
  /**
   * decrypt `ref`. the backend tag on `ref` MUST match `this.id` - the registry dispatcher
   * guarantees this. throws if the active vault no longer matches the recipient on the ref
   * (e.g. user encrypted in vault A and is now operating vault B).
   */
  decrypt(ref: EncryptedRef): Promise<Uint8Array>;
}

export class EncryptionBackendError extends Error {
  constructor(
    readonly backend: EncryptionBackendId,
    readonly reason: 'unsupported-recipient' | 'wrong-vault' | 'devnet-wipe' | 'protocol-error' | 'not-implemented',
    message: string,
  ) {
    super(`[${backend}/${reason}] ${message}`);
    this.name = 'EncryptionBackendError';
  }
}
