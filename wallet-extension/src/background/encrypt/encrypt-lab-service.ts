/**
 * Encrypt pre-alpha lab calls (grpc-web over fetch) - devnet experimentation only.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { encryptValue } from '@encrypt.xyz/pre-alpha-solana-client/grpc-web';
import { getSession, type CurveKey } from '@/background/session';
import { getDwalletEd25519PublicKey } from '@/background/chains/solana';
import { signMessageSol } from '@/background/chains/signing';
import { loadDwalletMeta, saveDwalletMeta } from '@/background/storage-meta';
import { STORAGE_KEYS } from '@/background/storage';
import { assertEncryptSolanaIkaBase, isEncryptAllowedForSession } from '@/background/encrypt/encrypt-guard';
import {
  ENCRYPT_PC_SWAP_BOOK_URL,
  ENCRYPT_PC_TOKEN_BOOK_URL,
  ENCRYPT_SOLANA_GRPC_URL,
  ENCRYPT_SOLANA_PROGRAM_ID,
} from '@/background/encrypt/encrypt-constants';
import { encodeReadCiphertextMessage } from '@/background/encrypt/encrypt-read-msg';
import {
  decodeCreateInputResponse,
  decodeReadCiphertextResponse,
  encodeCreateInputRequest,
  encodeReadCiphertextRequest,
} from '@/background/encrypt/encrypt-protobuf-wire';
import { encryptGrpcCreateInput, encryptGrpcReadCiphertext } from '@/background/encrypt/encrypt-grpc-web-fetch';

const GRPC_BASE = ENCRYPT_SOLANA_GRPC_URL.replace(/\/$/, '');

/**
 * pack 16 little-endian bytes into a bigint, suitable for `encryptValue(...)` input. used by
 * paths that already have a 16-byte buffer in hand (label chunks, AES key chunks) rather than
 * a numeric value.
 */
export function bytesLeToBigInt(le16: Uint8Array): bigint {
  if (le16.length !== 16) {
    throw new Error(`bytesLeToBigInt expects 16-byte value, got ${le16.length}`);
  }
  let v = 0n;
  for (let i = 0; i < 16; i++) {
    v |= BigInt(le16[i]!) << BigInt(i * 8);
  }
  return v;
}

const FHE_TYPE_EUINT64 = 4;
export const FHE_TYPE_EUINT128 = 5;
const LABEL_CHUNK_BYTES = 16;
const LABEL_MAX_CHUNKS = 4;
export const LABEL_MAX_UTF8_BYTES = LABEL_CHUNK_BYTES * LABEL_MAX_CHUNKS; // 64 utf-8 bytes total
const LABEL_FHE_TYPE = FHE_TYPE_EUINT128;

function encodeLabelToChunks(label: string): { chunks: Uint8Array[]; utf8Len: number } {
  const trimmed = label.trim();
  if (trimmed.length === 0) throw new Error('label cannot be empty');
  const utf8 = new TextEncoder().encode(trimmed);
  if (utf8.length > LABEL_MAX_UTF8_BYTES) {
    throw new Error(
      `label utf-8 length ${utf8.length} exceeds cap of ${LABEL_MAX_UTF8_BYTES} bytes (${LABEL_MAX_CHUNKS} EUint128 chunks of ${LABEL_CHUNK_BYTES} bytes each)`,
    );
  }
  const chunkCount = Math.max(1, Math.ceil(utf8.length / LABEL_CHUNK_BYTES));
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const off = i * LABEL_CHUNK_BYTES;
    const buf = new Uint8Array(LABEL_CHUNK_BYTES);
    buf.set(utf8.subarray(off, off + LABEL_CHUNK_BYTES), 0);
    chunks.push(buf);
  }
  return { chunks, utf8Len: utf8.length };
}

function decodeLabelFromChunks(chunkValues: Uint8Array[], utf8Len: number): string {
  if (utf8Len < 0 || utf8Len > LABEL_MAX_UTF8_BYTES) {
    throw new Error(`utf8Len ${utf8Len} out of range [0, ${LABEL_MAX_UTF8_BYTES}]`);
  }
  const flat = new Uint8Array(utf8Len);
  let written = 0;
  for (const chunk of chunkValues) {
    if (written >= utf8Len) break;
    const remaining = utf8Len - written;
    const take = Math.min(LABEL_CHUNK_BYTES, chunk.length, remaining);
    flat.set(chunk.subarray(0, take), written);
    written += take;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(flat);
}

/** backwards-compatible accessor: returns the chunk identifiers for a stored label. */
function labelIdentifierHexes(lbl: { ciphertextIdentifierHexes: string[] }): string[] {
  return lbl.ciphertextIdentifierHexes;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(s: string): Uint8Array {
  const t = s.trim().replace(/^0x/i, '');
  if (t.length % 2 !== 0) throw new Error('hex length must be even');
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(t.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function resolveNetworkEncryptionPublicKey(
  connection: Connection,
  programId: PublicKey,
  overrideHex?: string | null,
): Promise<Uint8Array> {
  const trimmed = overrideHex?.trim();
  if (trimmed && /^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed);
  }
  const seeds = ['network_encryption_key', 'network-encryption-key', 'NetworkEncryptionKey'];
  for (const label of seeds) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from(label)], programId);
    const ai = await connection.getAccountInfo(pda);
    if (!ai?.data || ai.data.length < 32) continue;
    const d = ai.data;
    if (d.length >= 40) {
      return new Uint8Array(d.subarray(8, 40));
    }
    return new Uint8Array(d.subarray(0, 32));
  }
  throw new Error(
    'could not read Encrypt network encryption key from devnet for this program id. paste 32-byte hex (64 chars) in the lab field or confirm program + rpc match Encrypt pre-alpha.',
  );
}

export function labConnection(): Connection {
  assertEncryptSolanaIkaBase();
  const s = getSession()!;
  const conn = s.dwalletSolanaConnection ?? s.solanaConnection;
  if (!conn) throw new Error('Solana RPC not configured');
  return conn;
}

export function signatureHexToEd25519Bytes(sig: string): Uint8Array {
  const h = sig.replace(/^0x/i, '');
  if (h.length !== 128) throw new Error('expected 64-byte ed25519 signature from ika path');
  return Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

export async function encryptLabCreateInputDemo(opts: {
  plainU64: number;
  networkEncryptionPublicKeyHex?: string | null;
}): Promise<{ ciphertextIdentifierHex: string; rawResponseNote: string }> {
  const connection = labConnection();
  const programId = new PublicKey(ENCRYPT_SOLANA_PROGRAM_ID);
  const networkPk = await resolveNetworkEncryptionPublicKey(
    connection,
    programId,
    opts.networkEncryptionPublicKeyHex,
  );
  const authorized = programId.toBytes();
  const req = encodeCreateInputRequest({
    chain: 0,
    inputs: [
      {
        ciphertextBytes: encryptValue(opts.plainU64, FHE_TYPE_EUINT64),
        fheType: FHE_TYPE_EUINT64,
      },
    ],
    proof: new Uint8Array(0),
    authorized: new Uint8Array(authorized),
    networkEncryptionPublicKey: networkPk,
  });
  const resBytes = await encryptGrpcCreateInput(GRPC_BASE, req);
  const parsed = decodeCreateInputResponse(resBytes);
  const id = parsed.ciphertextIdentifiers[0];
  if (!id) throw new Error('CreateInput returned no ciphertext identifiers');
  return {
    ciphertextIdentifierHex: hex(id),
    rawResponseNote: 'identifiers are executor-local handles for pre-alpha dev play, not production secrets.',
  };
}

/** batch CreateInput (one gRPC round-trip, one proof slot) - pre-alpha mock ciphertexts. */
export async function encryptLabCreateInputDemoBatch(opts: {
  plainU64Values: number[];
  networkEncryptionPublicKeyHex?: string | null;
}): Promise<{ ciphertextIdentifierHexes: string[]; rawResponseNote: string }> {
  const connection = labConnection();
  const programId = new PublicKey(ENCRYPT_SOLANA_PROGRAM_ID);
  const networkPk = await resolveNetworkEncryptionPublicKey(
    connection,
    programId,
    opts.networkEncryptionPublicKeyHex,
  );
  const authorized = programId.toBytes();
  const inputs = opts.plainU64Values.map((n) => ({
    ciphertextBytes: encryptValue(n, FHE_TYPE_EUINT64),
    fheType: FHE_TYPE_EUINT64,
  }));
  const req = encodeCreateInputRequest({
    chain: 0,
    inputs,
    proof: new Uint8Array(0),
    authorized: new Uint8Array(authorized),
    networkEncryptionPublicKey: networkPk,
  });
  const resBytes = await encryptGrpcCreateInput(GRPC_BASE, req);
  const parsed = decodeCreateInputResponse(resBytes);
  const hexes = parsed.ciphertextIdentifiers.map((id) => hex(id));
  if (hexes.length === 0) throw new Error('CreateInput returned no ciphertext identifiers');
  return {
    ciphertextIdentifierHexes: hexes,
    rawResponseNote: 'batch identifiers are executor-local handles for pre-alpha dev play.',
  };
}

export async function encryptLabReadCiphertextDemo(opts: {
  ciphertextIdentifierHex: string;
  epoch?: bigint;
}): Promise<{
  valueHex: string;
  fheType: number;
  digestHex: string;
  readPathNote: string;
}> {
  assertEncryptSolanaIkaBase();
  const ct = hexToBytes(opts.ciphertextIdentifierHex);
  const epoch = opts.epoch ?? 0n;
  const msg = encodeReadCiphertextMessage(0, ct, new Uint8Array(0), epoch);
  const { signature } = await signMessageSol(msg);
  const sigBytes = signatureHexToEd25519Bytes(signature);
  const signerPk = await getDwalletEd25519PublicKey();
  const req = encodeReadCiphertextRequest({
    message: msg,
    signature: sigBytes,
    signer: signerPk,
  });
  const resBytes = await encryptGrpcReadCiphertext(GRPC_BASE, req);
  const parsed = decodeReadCiphertextResponse(resBytes);
  return {
    valueHex: hex(parsed.value),
    fheType: parsed.fheType,
    digestHex: hex(parsed.digest),
    readPathNote:
      'this lab always uses a signed ReadCiphertext request (signMessageSol on the fee key, same style as other ed25519 ika paths). Encrypt docs also describe public ciphertext reads when the handle is public; that path does not hit this lab button.',
  };
}

/**
 * win 1 (labels-via-encrypt) - create an encrypted label for the active vault's dWallet on the
 * given curve. UTF-8-encodes the label into 16 bytes (left-justified, zero-padded), wraps in
 * the 17-byte fhe_type-prefixed scalar form, and submits via gRPC `CreateInput`. the resulting
 * ciphertext identifier is persisted in the per-vault dWallet meta overlay.
 *
 * lab-grade pre-alpha only - the executor disclaimer says ciphertexts can be plaintext on-chain.
 * never use for real secrets. see `wallet-extension/docs/STATUS.md` and the
 * `encrypt-solana-prealpha` skill (`references/gotchas.md`).
 */
export async function createDwalletLabelCiphertext(opts: {
  curve: CurveKey;
  label: string;
  networkEncryptionPublicKeyHex?: string | null;
  /**
   * when true, persist the plaintext label alongside the ciphertext identifiers so the
   * auto-rebuild flow can re-encrypt the same plaintext after a devnet wipe without
   * prompting. defaults to whatever the user-toggled setting at
   * `chromatika_label_auto_rebuild_v1` says. caller can pass `false` to override.
   */
  cachePlaintext?: boolean;
}): Promise<{
  ciphertextIdentifierHexes: string[];
  fheType: number;
  utf8Len: number;
  programId: string;
}> {
  assertEncryptSolanaIkaBase();
  const session = getSession();
  if (!session) throw new Error('Wallet locked');
  const vaultId = session.activeVaultId;

  const { chunks, utf8Len } = encodeLabelToChunks(opts.label);

  const connection = labConnection();
  const programId = new PublicKey(ENCRYPT_SOLANA_PROGRAM_ID);
  const networkPk = await resolveNetworkEncryptionPublicKey(
    connection,
    programId,
    opts.networkEncryptionPublicKeyHex,
  );

  // batch all chunks in a single CreateInput round-trip; the executor returns one
  // identifier per inputs[] entry in the same order.
  const authorized = programId.toBytes();
  const req = encodeCreateInputRequest({
    chain: 0,
    inputs: chunks.map((c) => ({
      ciphertextBytes: encryptValue(bytesLeToBigInt(c), LABEL_FHE_TYPE),
      fheType: LABEL_FHE_TYPE,
    })),
    proof: new Uint8Array(0),
    authorized: new Uint8Array(authorized),
    networkEncryptionPublicKey: networkPk,
  });
  const resBytes = await encryptGrpcCreateInput(GRPC_BASE, req);
  const parsed = decodeCreateInputResponse(resBytes);
  if (parsed.ciphertextIdentifiers.length !== chunks.length) {
    throw new Error(
      `CreateInput returned ${parsed.ciphertextIdentifiers.length} identifiers; expected ${chunks.length}`,
    );
  }
  const ciphertextIdentifierHexes = parsed.ciphertextIdentifiers.map((id) => hex(id));
  const createdAtMs = Date.now();

  // persist into the per-vault dwallet meta overlay (keyed by vaultId, scoped to curve).
  // when the auto-rebuild toggle is on (or caller explicitly opts in), stash the plaintext
  // alongside so a future devnet-wipe rebuild can rotate identifiers without prompting.
  const cachePlaintext =
    opts.cachePlaintext ?? (await getEncryptedLabelAutoRebuildEnabled());
  const meta = await loadDwalletMeta(vaultId);
  const curveMeta = meta[opts.curve] ?? { baseChain: 'solana' as const };
  const updated = {
    ...meta,
    [opts.curve]: {
      ...curveMeta,
      encryptedLabel: {
        ciphertextIdentifierHexes,
        fheType: LABEL_FHE_TYPE,
        createdAtMs,
        programId: ENCRYPT_SOLANA_PROGRAM_ID,
        utf8Len,
        ...(cachePlaintext ? { cachedPlaintext: opts.label } : {}),
      },
    },
  };
  await saveDwalletMeta(vaultId, updated);

  return {
    ciphertextIdentifierHexes,
    fheType: LABEL_FHE_TYPE,
    utf8Len,
    programId: ENCRYPT_SOLANA_PROGRAM_ID,
  };
}

/**
 * reveal an encrypted label by reading its stored ciphertext identifier from the per-vault
 * dWallet meta overlay, signing a ReadCiphertext message via the existing `signMessageSol`
 * ed25519 path, and decoding the returned 16-byte value back to utf-8 (trimmed to `utf8Len`).
 *
 * throws when no label is set for the curve, when the wallet is locked, or when the executor
 * returns an error (e.g. devnet wipe rotated identifiers - tracked as a known caveat).
 */
export async function revealDwalletLabelCiphertext(opts: { curve: CurveKey }): Promise<{
  label: string;
  fheType: number;
  createdAtMs: number;
  programId: string;
  digestHexes: string[];
  chunkCount: number;
}> {
  assertEncryptSolanaIkaBase();
  const session = getSession();
  if (!session) throw new Error('Wallet locked');
  const vaultId = session.activeVaultId;

  const meta = await loadDwalletMeta(vaultId);
  const curveMeta = meta[opts.curve];
  const lbl = curveMeta?.encryptedLabel;
  if (!lbl) {
    throw new Error(`no encrypted label set for ${opts.curve} dWallet on the active vault`);
  }
  const ids = labelIdentifierHexes(lbl);
  if (ids.length === 0) {
    throw new Error('encrypted label record has no ciphertext identifiers');
  }

  const signerPk = await getDwalletEd25519PublicKey();
  const chunkValues: Uint8Array[] = [];
  const digestHexes: string[] = [];
  let lastFheType = 0;
  for (const idHex of ids) {
    const ct = hexToBytes(idHex);
    const epoch = 0n;
    const msg = encodeReadCiphertextMessage(0, ct, new Uint8Array(0), epoch);
    const { signature } = await signMessageSol(msg);
    const sigBytes = signatureHexToEd25519Bytes(signature);
    const req = encodeReadCiphertextRequest({
      message: msg,
      signature: sigBytes,
      signer: signerPk,
    });
    const resBytes = await encryptGrpcReadCiphertext(GRPC_BASE, req);
    const parsed = decodeReadCiphertextResponse(resBytes);
    chunkValues.push(parsed.value);
    digestHexes.push(hex(parsed.digest));
    lastFheType = parsed.fheType;
  }

  const label = decodeLabelFromChunks(chunkValues, lbl.utf8Len);
  return {
    label,
    fheType: lastFheType,
    createdAtMs: lbl.createdAtMs,
    programId: lbl.programId,
    digestHexes,
    chunkCount: ids.length,
  };
}

/**
 * read whether an encrypted label exists for the given curve on the active vault. non-throwing -
 * surfaces a `enabledForSession` flag so UI can hide the entire widget on Sui-base vaults rather
 * than render an error. returns the label's metadata (timestamp, program id, utf8 length) but
 * NOT the ciphertext id - the reveal path is the only consumer of that, and it reads from meta
 * directly.
 */
export async function getDwalletEncryptedLabelStatus(opts: { curve: CurveKey }): Promise<{
  enabledForSession: boolean;
  hasLabel: boolean;
  createdAtMs: number | null;
  programId: string | null;
  utf8Len: number | null;
  chunkCount: number | null;
  maxUtf8Bytes: number;
}> {
  const base = {
    enabledForSession: false,
    hasLabel: false,
    createdAtMs: null,
    programId: null,
    utf8Len: null,
    chunkCount: null,
    maxUtf8Bytes: LABEL_MAX_UTF8_BYTES,
  } as const;
  if (!isEncryptAllowedForSession()) return { ...base };
  const session = getSession();
  if (!session) return { ...base };
  const meta = await loadDwalletMeta(session.activeVaultId);
  const lbl = meta[opts.curve]?.encryptedLabel;
  if (!lbl) {
    return { ...base, enabledForSession: true };
  }
  return {
    enabledForSession: true,
    hasLabel: true,
    createdAtMs: lbl.createdAtMs,
    programId: lbl.programId,
    utf8Len: lbl.utf8Len,
    chunkCount: lbl.ciphertextIdentifierHexes.length,
    maxUtf8Bytes: LABEL_MAX_UTF8_BYTES,
  };
}

/**
 * one-shot read of the on-chain status of a label's ciphertext account(s). per the encrypt
 * skill (`references/gotchas.md` -> "ciphertext account on-chain layout"), the account is 100
 * bytes total: status byte at offset 99 (0 = Pending, 1 = Verified), fhe_type at offset 98.
 *
 * for gRPC `CreateInput` ciphertexts the executor verifies on creation (`flows.md` flow 2),
 * so the status should be 1 immediately. we surface the actual on-chain state anyway because
 * (a) the executor may briefly lag, (b) devnet wipes will clear the account entirely (status =
 * 'missing'), and (c) UX-wise a green check next to the label tells the user "yes, this
 * really lives on chain."
 *
 * for multi-chunk labels we read every chunk's account and report the worst case
 * (any pending = pending, any missing = missing, all verified = verified).
 */
export async function getDwalletEncryptedLabelOnChainStatus(opts: { curve: CurveKey }): Promise<{
  status: 'verified' | 'pending' | 'missing' | 'no-label';
  chunks: Array<{ ciphertextIdentifierHex: string; accountExists: boolean; statusByte: number | null; fheType: number | null }>;
}> {
  assertEncryptSolanaIkaBase();
  const session = getSession();
  if (!session) throw new Error('Wallet locked');
  const meta = await loadDwalletMeta(session.activeVaultId);
  const lbl = meta[opts.curve]?.encryptedLabel;
  if (!lbl) {
    return { status: 'no-label', chunks: [] };
  }

  const connection = labConnection();
  const ids = labelIdentifierHexes(lbl);
  const chunks: Array<{ ciphertextIdentifierHex: string; accountExists: boolean; statusByte: number | null; fheType: number | null }> = [];
  let anyPending = false;
  let anyMissing = false;
  for (const idHex of ids) {
    const pk = new PublicKey(hexToBytes(idHex));
    const ai = await connection.getAccountInfo(pk, connection.commitment ?? 'confirmed');
    if (!ai?.data || ai.data.length < 100) {
      chunks.push({ ciphertextIdentifierHex: idHex, accountExists: false, statusByte: null, fheType: null });
      anyMissing = true;
      continue;
    }
    const statusByte = ai.data[99] ?? null;
    const fheType = ai.data[98] ?? null;
    chunks.push({ ciphertextIdentifierHex: idHex, accountExists: true, statusByte, fheType });
    if (statusByte !== 1) anyPending = true;
  }
  const overall: 'verified' | 'pending' | 'missing' = anyMissing ? 'missing' : anyPending ? 'pending' : 'verified';
  return { status: overall, chunks };
}

/**
 * drop the encrypted label entry from the per-vault dWallet meta overlay. the on-chain
 * ciphertext account stays (devnet wipe will reclaim it eventually); we just forget the local
 * pointer. no-op when no label is set.
 */
export async function clearDwalletLabelCiphertext(opts: { curve: CurveKey }): Promise<void> {
  assertEncryptSolanaIkaBase();
  const session = getSession();
  if (!session) throw new Error('Wallet locked');
  const vaultId = session.activeVaultId;

  const meta = await loadDwalletMeta(vaultId);
  const curveMeta = meta[opts.curve];
  if (!curveMeta?.encryptedLabel) return;
  const { encryptedLabel: _drop, ...rest } = curveMeta;
  void _drop;
  await saveDwalletMeta(vaultId, {
    ...meta,
    [opts.curve]: rest,
  });
}

// ─── encrypt-label auto-rebuild after devnet wipe ────────────────────────────────

/**
 * storage key for the user-facing toggle. when `true`, future label-encrypt calls cache
 * the plaintext locally and a "missing on-chain" detection auto-rebuilds (no prompt).
 * when `false`, the user must hit a manual "rebuild" button per dWallet (still works
 * IFF a plaintext is cached from a prior session when the toggle was on).
 */
const LABEL_AUTO_REBUILD_STORAGE_KEY = STORAGE_KEYS.LABEL_AUTO_REBUILD_V1;

export async function getEncryptedLabelAutoRebuildEnabled(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.get([LABEL_AUTO_REBUILD_STORAGE_KEY], (r) => {
      resolve(r[LABEL_AUTO_REBUILD_STORAGE_KEY] === true);
    });
  });
}

export async function setEncryptedLabelAutoRebuildEnabled(enabled: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [LABEL_AUTO_REBUILD_STORAGE_KEY]: enabled }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/**
 * re-encrypt a previously-encrypted label using the locally-cached plaintext, after the
 * on-chain ciphertext accounts have been wiped (typical on Encrypt devnet rotation). this
 * runs the same gRPC `CreateInput` flow as the initial encrypt and rotates
 * `ciphertextIdentifierHexes` in place; `createdAtMs` stamps fresh.
 *
 * throws when:
 *   - no label is set for the curve / wallet locked / non-solana-base session
 *   - no `cachedPlaintext` is stored (user never opted in / encrypted before the
 *     auto-rebuild feature shipped). UI tells the user to clear + re-encrypt manually.
 *
 * idempotent against parallel calls insofar as the on-chain CreateInput is itself
 * idempotent on the executor (returns the same identifiers for the same authorized key
 * within a session). the local meta overwrite is last-writer-wins.
 */
export async function rebuildDwalletLabelAfterDevnetWipe(opts: {
  curve: CurveKey;
}): Promise<{
  ciphertextIdentifierHexes: string[];
  rebuilt: true;
  rebuiltAtMs: number;
}> {
  assertEncryptSolanaIkaBase();
  const session = getSession();
  if (!session) throw new Error('Wallet locked');

  const meta = await loadDwalletMeta(session.activeVaultId);
  const lbl = meta[opts.curve]?.encryptedLabel;
  if (!lbl) {
    throw new Error(`no encrypted label set for ${opts.curve} dWallet on the active vault`);
  }
  if (!lbl.cachedPlaintext) {
    throw new Error(
      'no cached plaintext for this label; auto-rebuild requires the toggle to have been on at encrypt time. Clear and re-encrypt to rebuild.',
    );
  }
  // re-run the encrypt with the same plaintext. pass `cachePlaintext: true` explicitly so
  // the rotated meta keeps the cached plaintext (in case a future wipe needs another rebuild).
  const out = await createDwalletLabelCiphertext({
    curve: opts.curve,
    label: lbl.cachedPlaintext,
    cachePlaintext: true,
  });
  return {
    ciphertextIdentifierHexes: out.ciphertextIdentifierHexes,
    rebuilt: true,
    rebuiltAtMs: Date.now(),
  };
}

/** static pointers for ENC / SPL deposit work (no on-chain builder here yet). */
export function encryptDepositImplementationHint(): {
  instructionsUrl: string;
  pcTokenBookUrl: string;
  pcSwapBookUrl: string;
  note: string;
  vaultIsSolanaIkaBase: boolean;
} {
  return {
    instructionsUrl: 'https://docs.encrypt.xyz/reference/instructions.html',
    pcTokenBookUrl: ENCRYPT_PC_TOKEN_BOOK_URL,
    pcSwapBookUrl: ENCRYPT_PC_SWAP_BOOK_URL,
    note:
      'EncryptDeposit uses ENC (SPL) plus SOL via create_deposit and top_up (pre-alpha devnet). Wallet ATA or top-up builders ship incrementally; see instruction reference.',
    vaultIsSolanaIkaBase: isEncryptAllowedForSession(),
  };
}
