/**
 * read a user's pcToken balance:
 *   1. derive their TokenAccount PDA from `(mint, owner)`
 *   2. fetch the on-chain account; extract the current `balance.ciphertext_pubkey` field
 *   3. encode + sign a `ReadCiphertext` message under the active dWallet ed25519 (1× ika sign)
 *   4. gRPC `ReadCiphertext` returns the plaintext u64 amount in LE
 *
 * cached per (mint, owner) for 60s to avoid hammering on UI re-renders. cache busts on any local
 * pc-* tx broadcast (handled by the flows orchestrator).
 *
 * decrypt latency: ~1-3s on devnet (one ika MPC sign + one gRPC round-trip). UI shows a spinner.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { signMessageSol } from '@/background/chains/signing';
import { getDwalletEd25519PublicKey } from '@/background/chains/solana';
import {
  decodeReadCiphertextResponse,
  encodeReadCiphertextRequest,
} from '@/background/encrypt/encrypt-protobuf-wire';
import { encryptGrpcReadCiphertext } from '@/background/encrypt/encrypt-grpc-web-fetch';
import { encodeReadCiphertextMessage } from '@/background/encrypt/encrypt-read-msg';
import {
  signatureHexToEd25519Bytes,
} from '@/background/encrypt/encrypt-lab-service';
import {
  ENCRYPT_SOLANA_GRPC_URL,
} from '@/background/encrypt/encrypt-constants';
import { derivePcAccountPda } from '@/background/encrypt-pc/pc-token-pda';
import { PcTokenError, type PcBalance } from '@/background/encrypt-pc/pc-token-types';

const GRPC_BASE = ENCRYPT_SOLANA_GRPC_URL.replace(/\/$/, '');

/**
 * on-chain layout of the PC-Token TokenAccount PDA (per upstream pinocchio program). the
 * `balance.ciphertext_pubkey` field is the moving target we ReadCiphertext against. layout
 * confirmed in spike notes; if the upstream layout changes, adjust here.
 *
 * we only need the offset of the ciphertext_pubkey field (32 bytes). for v0 we use a heuristic:
 * the account is small (< 200 bytes) and the ciphertext_pubkey is one of the last 32-byte fields.
 * the strict layout decoder lands when we have a definitive on-chain example to align against;
 * if the heuristic fails the user sees a clear `protocol-error` with the raw data length.
 */
const TOKEN_ACCOUNT_BALANCE_CT_OFFSET = 8 + 1 + 32 + 32; // discriminator + bump + mint + owner; balance starts here

interface BalanceCacheEntry {
  balanceBaseUnits: bigint;
  decryptedAtMs: number;
}

const CACHE_TTL_MS = 60_000;
const balanceCache = new Map<string, BalanceCacheEntry>();

function cacheKey(mint: PublicKey, owner: PublicKey): string {
  return `${mint.toBase58()}::${owner.toBase58()}`;
}

export function bustPcBalanceCache(opts: { mint?: PublicKey; owner?: PublicKey }): void {
  if (!opts.mint || !opts.owner) {
    balanceCache.clear();
    return;
  }
  balanceCache.delete(cacheKey(opts.mint, opts.owner));
}

/**
 * read the on-chain pcToken balance. returns `accountExists: false` when the user has not
 * called `InitializeAccount` for this mint yet.
 */
export async function readPcBalance(args: {
  connection: Connection;
  pcMint: PublicKey;
  owner: PublicKey;
  splMintB58: string;
}): Promise<PcBalance> {
  const key = cacheKey(args.pcMint, args.owner);
  const cached = balanceCache.get(key);
  if (cached && Date.now() - cached.decryptedAtMs < CACHE_TTL_MS) {
    return {
      splMint: args.splMintB58,
      balanceBaseUnits: cached.balanceBaseUnits.toString(),
      decryptedAtMs: cached.decryptedAtMs,
      accountExists: true,
    };
  }

  const { pda: tokenAccountPda } = derivePcAccountPda(args.pcMint, args.owner);
  const accountInfo = await args.connection.getAccountInfo(tokenAccountPda, 'confirmed');
  if (!accountInfo) {
    return {
      splMint: args.splMintB58,
      balanceBaseUnits: '0',
      decryptedAtMs: Date.now(),
      accountExists: false,
    };
  }
  if (accountInfo.data.length < TOKEN_ACCOUNT_BALANCE_CT_OFFSET + 32) {
    throw new PcTokenError(
      'protocol-error',
      `TokenAccount data too short: ${accountInfo.data.length} bytes`,
    );
  }
  const balanceCtBytes = accountInfo.data.subarray(
    TOKEN_ACCOUNT_BALANCE_CT_OFFSET,
    TOKEN_ACCOUNT_BALANCE_CT_OFFSET + 32,
  );
  const balanceCtPubkey = new PublicKey(balanceCtBytes);

  const msg = encodeReadCiphertextMessage(0, balanceCtPubkey.toBytes(), new Uint8Array(0), 0n);
  let sigHex: string;
  try {
    const signed = await signMessageSol(msg);
    sigHex = signed.signature;
  } catch (e) {
    throw new PcTokenError(
      'wallet-locked',
      `signMessageSol failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const sigBytes = signatureHexToEd25519Bytes(sigHex);
  const signerPk = await getDwalletEd25519PublicKey();
  const req = encodeReadCiphertextRequest({ message: msg, signature: sigBytes, signer: signerPk });
  let resBytes: Uint8Array;
  try {
    resBytes = await encryptGrpcReadCiphertext(GRPC_BASE, req);
  } catch (e) {
    const msgText = e instanceof Error ? e.message : String(e);
    if (/not.found|missing|unknown.identifier/i.test(msgText)) {
      throw new PcTokenError(
        'devnet-wipe',
        `balance ciphertext no longer exists on devnet (likely cleared by a wipe). Re-wrap to recover. Raw: ${msgText}`,
      );
    }
    throw new PcTokenError('protocol-error', `ReadCiphertext gRPC failed: ${msgText}`);
  }
  const parsed = decodeReadCiphertextResponse(resBytes);
  // EUint64 plaintext is 8 bytes LE.
  if (parsed.value.length < 8) {
    throw new PcTokenError(
      'protocol-error',
      `expected at least 8 bytes for u64 balance, got ${parsed.value.length}`,
    );
  }
  let balance = 0n;
  for (let i = 7; i >= 0; i--) {
    balance = (balance << 8n) | BigInt(parsed.value[i]!);
  }
  balanceCache.set(key, { balanceBaseUnits: balance, decryptedAtMs: Date.now() });
  return {
    splMint: args.splMintB58,
    balanceBaseUnits: balance.toString(),
    decryptedAtMs: Date.now(),
    accountExists: true,
  };
}
