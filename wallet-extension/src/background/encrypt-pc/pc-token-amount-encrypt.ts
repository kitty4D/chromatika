/**
 * encrypt a u64 amount via the existing Encrypt CreateInput gRPC, returning the ciphertext
 * identifier (which is a Solana pubkey for the on-chain ciphertext account). PC-Token's wrap /
 * transfer / unwrap-burn instructions all consume an `amountCt` whose pubkey is the result of
 * this call.
 *
 * reuse layer:
 *   - `encryptValue(value, fheType=4)` from `@encrypt.xyz/pre-alpha-solana-client/grpc-web`
 *     produces the 17-byte `[fhe_type(1) || value_le(16)]` form the executor expects.
 *   - `encodeCreateInputRequest` / `decodeCreateInputResponse` from encrypt-protobuf-wire.ts
 *     handle the wire codec.
 *   - `encryptGrpcCreateInput` from encrypt-grpc-web-fetch.ts is the gRPC unary call.
 *   - `resolveNetworkEncryptionPublicKey` from encrypt-lab-service.ts resolves the live network key.
 *
 * the only PC-Token-specific bit is `authorized = PC_TOKEN_PROGRAM_ID.toBytes()` (vs the Encrypt
 * program for label encryption). this authorizes the PC-Token program to use the ciphertext;
 * label encryption authorizes the Encrypt program itself.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import {
  getPcTokenProgramId,
  isPcTokenConfigured,
  ENCRYPT_FHE_TYPE,
} from '@/background/encrypt-pc/pc-token-program';
import { PcTokenError } from '@/background/encrypt-pc/pc-token-types';
import {
  encodeCreateInputRequest,
  decodeCreateInputResponse,
} from '@/background/encrypt/encrypt-protobuf-wire';
import { encryptGrpcCreateInput } from '@/background/encrypt/encrypt-grpc-web-fetch';
import { encryptValue } from '@encrypt.xyz/pre-alpha-solana-client/grpc-web';
import {
  ENCRYPT_SOLANA_GRPC_URL,
  ENCRYPT_SOLANA_PROGRAM_ID,
} from '@/background/encrypt/encrypt-constants';
import {
  resolveNetworkEncryptionPublicKey,
} from '@/background/encrypt/encrypt-lab-service';

const GRPC_BASE = ENCRYPT_SOLANA_GRPC_URL.replace(/\/$/, '');

export interface EncryptAmountResult {
  /** the on-chain pubkey of the ciphertext account (returned as `ciphertext_identifier`). */
  ciphertextIdentifier: PublicKey;
  /** the 32-byte network encryption key resolved during the call (cached for subsequent ops). */
  networkKey32: Uint8Array;
}

/**
 * encrypt a single u64 amount. PC-Token's UnwrapBurn needs TWO encrypted ciphertexts (the
 * requested amount + the initially-zero `burnedCt` that the FHE graph writes the actually-burned
 * amount into); use `encryptAmountsBatch` for that case to keep both inputs in one gRPC round-trip.
 */
export interface EncryptAmountOpts {
  /** override the network encryption key resolution (skip the on-chain RPC fetch). */
  networkKeyOverride?: Uint8Array;
  /**
   * override the PC-Token program ID used as `authorized`. when set, the active-market fallback
   * via `getPcTokenProgramId()` is skipped - useful when the caller already resolved a specific
   * market entry (multi-market support).
   */
  programIdOverride?: PublicKey;
}

export async function encryptAmount(
  connection: Connection,
  payer: PublicKey,
  amountBaseUnits: bigint,
  opts: EncryptAmountOpts = {},
): Promise<EncryptAmountResult> {
  const { networkKeyOverride, programIdOverride } = opts;
  if (!programIdOverride && !isPcTokenConfigured()) {
    throw new PcTokenError(
      'not-configured',
      'cannot encrypt amount until a PC-Token market is configured',
    );
  }
  if (amountBaseUnits < 0n) {
    throw new PcTokenError('protocol-error', `amount must be non-negative, got ${amountBaseUnits}`);
  }
  if (amountBaseUnits > (1n << 64n) - 1n) {
    throw new PcTokenError('protocol-error', `amount exceeds u64 max: ${amountBaseUnits}`);
  }
  void payer; // payer reserved for future per-payer auth scoping (e.g. once authorized supports recipients)
  // network_encryption_key PDA lives under the Encrypt protocol program, NOT the consumer
  // PC-Token program. `authorized` is the PC-Token program (CPI caller into Encrypt).
  const pcTokenProgramId = programIdOverride ?? getPcTokenProgramId();
  const encryptProgramId = new PublicKey(ENCRYPT_SOLANA_PROGRAM_ID);
  const networkKey =
    networkKeyOverride ?? (await resolveNetworkEncryptionPublicKey(connection, encryptProgramId));
  const authorized = pcTokenProgramId.toBytes();
  const encoded = encodeCreateInputRequest({
    chain: 0, // Solana
    inputs: [
      {
        ciphertextBytes: encryptValue(amountBaseUnits, ENCRYPT_FHE_TYPE.EUint64),
        fheType: ENCRYPT_FHE_TYPE.EUint64,
      },
    ],
    proof: new Uint8Array(0),
    authorized: new Uint8Array(authorized),
    networkEncryptionPublicKey: networkKey,
  });
  let resBytes: Uint8Array;
  try {
    resBytes = await encryptGrpcCreateInput(GRPC_BASE, encoded);
  } catch (e) {
    throw new PcTokenError(
      'protocol-error',
      `CreateInput gRPC failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const parsed = decodeCreateInputResponse(resBytes);
  const id = parsed.ciphertextIdentifiers[0];
  if (!id) {
    throw new PcTokenError('protocol-error', 'CreateInput returned no ciphertext identifiers');
  }
  if (id.length !== 32) {
    throw new PcTokenError(
      'protocol-error',
      `ciphertext_identifier must be 32 bytes, got ${id.length}`,
    );
  }
  return { ciphertextIdentifier: new PublicKey(id), networkKey32: networkKey };
}

/**
 * encrypt 2 amounts in a single gRPC round-trip. UnwrapBurn calls this with [requestedAmount, 0]
 * to get its `amountCt` + `burnedCt` pair without a second network round-trip.
 */
export async function encryptAmountsBatch(
  connection: Connection,
  payer: PublicKey,
  amounts: bigint[],
  opts: EncryptAmountOpts = {},
): Promise<{ ciphertextIdentifiers: PublicKey[]; networkKey32: Uint8Array }> {
  const { networkKeyOverride, programIdOverride } = opts;
  if (!programIdOverride && !isPcTokenConfigured()) {
    throw new PcTokenError(
      'not-configured',
      'cannot encrypt amounts until a PC-Token market is configured',
    );
  }
  if (amounts.length === 0) {
    throw new PcTokenError('protocol-error', 'empty amounts array');
  }
  for (const a of amounts) {
    if (a < 0n) throw new PcTokenError('protocol-error', `amount must be non-negative, got ${a}`);
    if (a > (1n << 64n) - 1n) throw new PcTokenError('protocol-error', `amount exceeds u64 max: ${a}`);
  }
  void payer;
  const pcTokenProgramId = programIdOverride ?? getPcTokenProgramId();
  const encryptProgramId = new PublicKey(ENCRYPT_SOLANA_PROGRAM_ID);
  const networkKey =
    networkKeyOverride ?? (await resolveNetworkEncryptionPublicKey(connection, encryptProgramId));
  const authorized = pcTokenProgramId.toBytes();
  const encoded = encodeCreateInputRequest({
    chain: 0,
    inputs: amounts.map((a) => ({
      ciphertextBytes: encryptValue(a, ENCRYPT_FHE_TYPE.EUint64),
      fheType: ENCRYPT_FHE_TYPE.EUint64,
    })),
    proof: new Uint8Array(0),
    authorized: new Uint8Array(authorized),
    networkEncryptionPublicKey: networkKey,
  });
  let resBytes: Uint8Array;
  try {
    resBytes = await encryptGrpcCreateInput(GRPC_BASE, encoded);
  } catch (e) {
    throw new PcTokenError(
      'protocol-error',
      `CreateInput gRPC failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const parsed = decodeCreateInputResponse(resBytes);
  if (parsed.ciphertextIdentifiers.length !== amounts.length) {
    throw new PcTokenError(
      'protocol-error',
      `expected ${amounts.length} identifiers, got ${parsed.ciphertextIdentifiers.length}`,
    );
  }
  return {
    ciphertextIdentifiers: parsed.ciphertextIdentifiers.map((b) => new PublicKey(b)),
    networkKey32: networkKey,
  };
}
