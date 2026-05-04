/**
 * read ika Solana devnet dWallet accounts (pre-alpha program) without pulling in
 * `dwallet-derived-addresses` (avoids circular imports with `bitcoin.ts`).
 *
 * program id must stay aligned with `solana-grpc-client.ts` SOLANA_PREALPHA_PROGRAM_ID.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { Curve } from '@ika.xyz/sdk';
import type { CurveKey } from '@/background/session';

/** keep in sync with `@/background/ika/solana-grpc-client` SOLANA_PREALPHA_PROGRAM_ID */
const SOLANA_PREALPHA_PROGRAM_ID = '87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY';

const PROGRAM = new PublicKey(SOLANA_PREALPHA_PROGRAM_ID);

/** Sui ika dWallet object id (66-char 0x + 64 hex). */
export function isSuiIkaDwalletObjectId(id: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(id.trim());
}

function curveByteToSdk(curveByte: number): typeof Curve.SECP256K1 | typeof Curve.ED25519 {
  if (curveByte === 0) return Curve.SECP256K1;
  if (curveByte === 2) return Curve.ED25519;
  throw new Error(`unsupported Solana dWallet curve byte: ${curveByte}`);
}

function curveByteToKey(curveByte: number): CurveKey {
  if (curveByte === 0) return 'SECP256K1';
  if (curveByte === 2) return 'ED25519';
  throw new Error(`unsupported Solana dWallet curve byte: ${curveByte}`);
}

export function parseSolanaDWalletAccountData(data: Uint8Array): {
  curveByte: number;
  publicOutput: Uint8Array;
  curveKey: CurveKey;
} {
  if (data.length < 103) {
    throw new Error(`dWallet account data too short (${data.length} bytes)`);
  }
  const curveLow = data[34];
  const curveHigh = data[35];
  if (curveHigh !== 0) {
    throw new Error(`unexpected dWallet curve high byte: ${curveHigh}`);
  }
  const curveByte = curveLow;
  const pkLen = data[37];
  if (pkLen < 32 || pkLen > 65) {
    throw new Error(`invalid dWallet public_key_len: ${pkLen}`);
  }
  if (data.length < 38 + pkLen) {
    throw new Error(`dWallet account data truncated: need ${38 + pkLen} bytes, got ${data.length}`);
  }
  const publicOutput = data.slice(38, 38 + pkLen);
  return {
    curveByte,
    publicOutput,
    curveKey: curveByteToKey(curveByte),
  };
}

export async function fetchSolanaDWalletAccount(
  connection: Connection,
  dwalletIdB58: string,
): Promise<{ curveKey: CurveKey; publicOutput: Uint8Array; curveSdk: typeof Curve.SECP256K1 | typeof Curve.ED25519 }> {
  const pk = new PublicKey(dwalletIdB58);
  const info = await connection.getAccountInfo(pk);
  if (!info) throw new Error(`Solana dWallet account not found: ${dwalletIdB58.slice(0, 8)}…`);
  if (!info.owner.equals(PROGRAM)) {
    throw new Error('account is not owned by the ika Solana dWallet program');
  }
  const { curveKey, publicOutput, curveByte } = parseSolanaDWalletAccountData(info.data);
  return { curveKey, publicOutput, curveSdk: curveByteToSdk(curveByte) };
}

/**
 * lightweight existence + ownership probe. returns `true` only when the account exists and is
 * owned by the ika dWallet program (so a stray Solana account at the same address can't fool us
 * into thinking the network operator committed it). used by the DKG post-poll and by the
 * sign-time `DWalletGoneError` sniff to distinguish "wiped" from "NOA hasn't committed yet".
 */
export async function solanaDwalletPdaExists(
  connection: Connection,
  dwalletIdB58: string,
): Promise<boolean> {
  try {
    const pk = new PublicKey(dwalletIdB58);
    const info = await connection.getAccountInfo(pk);
    if (!info) return false;
    return info.owner.equals(PROGRAM);
  } catch {
    return false;
  }
}

export interface PollForSolanaDwalletPdaOptions {
  /** total time to wait. defaults to 60s. */
  timeoutMs?: number;
  /** poll interval. defaults to 2s (NOA commits are typically a few seconds, no need to hammer). */
  intervalMs?: number;
  /** callback fires every poll tick with elapsed ms; lets the caller drive a progress banner. */
  onPoll?(elapsedMs: number): void;
}

/**
 * poll Solana RPC for the dWallet PDA's account info until it exists (and is program-owned).
 * resolves on success; throws when the timeout elapses with no on-chain anchor. use to bridge
 * the gap between the gRPC `requestDKG` returning an attestation and the network operator
 * relaying `CommitDWallet` (disc 31) onto Solana.
 */
export async function pollForSolanaDwalletPda(
  connection: Connection,
  dwalletIdB58: string,
  options: PollForSolanaDwalletPdaOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const start = Date.now();
  // tick immediately so the caller sees a stage update before the first sleep.
  options.onPoll?.(0);
  while (Date.now() - start < timeoutMs) {
    if (await solanaDwalletPdaExists(connection, dwalletIdB58)) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    options.onPoll?.(Date.now() - start);
  }
  throw new Error(
    `Ika network operator hasn't committed dWallet ${dwalletIdB58.slice(0, 8)}… on-chain after ${Math.round(timeoutMs / 1000)}s. The Ika devnet pipeline may be paused. Address: ${dwalletIdB58}.`,
  );
}
