/**
 * detect whether a serialized Solana transaction invokes the Encrypt program id.
 * used for activity labels and bridge telemetry (no Sui paths).
 */

import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { ENCRYPT_SOLANA_PROGRAM_ID } from '@/background/encrypt/encrypt-constants';

const encryptPk = (): PublicKey => new PublicKey(ENCRYPT_SOLANA_PROGRAM_ID);

export function versionedWireInvokesEncryptProgram(wire: Uint8Array): boolean {
  let vtx: VersionedTransaction;
  try {
    vtx = VersionedTransaction.deserialize(wire);
  } catch {
    return false;
  }
  const keys = vtx.message.staticAccountKeys;
  const pid = encryptPk();
  for (const ix of vtx.message.compiledInstructions) {
    const prog = keys[ix.programIdIndex];
    if (prog && prog.equals(pid)) return true;
  }
  return false;
}

/** legacy `Transaction` wire (older dapps / native SOL send). */
export function legacyWireInvokesEncryptProgram(wire: Uint8Array): boolean {
  try {
    const tx = Transaction.from(wire);
    const pid = encryptPk();
    for (const ix of tx.instructions) {
      if (ix.programId.equals(pid)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function solanaWireInvokesEncryptProgram(wire: Uint8Array): boolean {
  return versionedWireInvokesEncryptProgram(wire) || legacyWireInvokesEncryptProgram(wire);
}

function programIdToBase58(p: unknown): string {
  if (typeof p === 'string') return p;
  if (p && typeof (p as PublicKey).toBase58 === 'function') return (p as PublicKey).toBase58();
  return '';
}

function instructionProgramTouchesEncrypt(programId: unknown): boolean {
  return programIdToBase58(programId) === ENCRYPT_SOLANA_PROGRAM_ID;
}

/** use with `getParsedTransaction` for activity labels (no extra wire deserialize). */
export function parsedTransactionTouchesEncrypt(parsed: ParsedTransactionWithMeta): boolean {
  const msg = parsed.transaction.message;
  const top = msg.instructions;
  for (const ix of top) {
    if ('programId' in ix && instructionProgramTouchesEncrypt((ix as { programId: unknown }).programId)) return true;
  }
  const inner = parsed.meta?.innerInstructions;
  if (inner) {
    for (const group of inner) {
      for (const ix of group.instructions) {
        if (instructionProgramTouchesEncrypt(ix.programId)) return true;
      }
    }
  }
  return false;
}
