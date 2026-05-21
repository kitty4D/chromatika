/**
 * Solana tx classifier. Maps a parsed Solana tx → semantic kind by checking program IDs
 * that appear in the tx's instructions.
 *
 * Phase 2 design: the walker indexes signatures (cheap pagination) without per-tx parsing.
 * Classification needs `getParsedTransaction(sig)` which is expensive (~200ms/tx + RPC
 * round-trip). We expose this as a separate function the walker calls lazily for the top
 * 12 rows of each page; older rows store `kind: 'unknown'` and reclassify on next visit.
 *
 * Known program IDs we recognize (Phase 2 list; extendable):
 *   - 11111111111111111111111111111111            (System Program)
 *   - TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA (SPL Token)
 *   - MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr (Memo Program)
 *   - JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 (Jupiter v6 aggregator)
 *   - JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB (Jupiter v4)
 *   - 9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP (Orca Whirlpools)
 *   - 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 (Raydium AMM v4)
 *   - Stake11111111111111111111111111111111111111 (Stake Program)
 */

import type { IndexedTxKind, IndexedTx } from '@/background/services/activity-index';

export const SOLANA_PROGRAM_IDS = {
  SYSTEM: '11111111111111111111111111111111',
  TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  MEMO_V2: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  MEMO_V1: 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  STAKE: 'Stake11111111111111111111111111111111111111',
  ASSOCIATED_TOKEN: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  JUPITER_V4: 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  ORCA: '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
  RAYDIUM_AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
} as const;

const SWAP_PROGRAM_IDS = new Set<string>([
  SOLANA_PROGRAM_IDS.JUPITER_V6,
  SOLANA_PROGRAM_IDS.JUPITER_V4,
  SOLANA_PROGRAM_IDS.ORCA,
  SOLANA_PROGRAM_IDS.RAYDIUM_AMM_V4,
]);

const STAKE_PROGRAM_IDS = new Set<string>([SOLANA_PROGRAM_IDS.STAKE]);

const MEMO_PROGRAM_IDS = new Set<string>([SOLANA_PROGRAM_IDS.MEMO_V1, SOLANA_PROGRAM_IDS.MEMO_V2]);

/** shape of the minimal subset of `getParsedTransaction` output we need. */
export type ParsedTxLite = {
  transaction?: {
    message?: {
      instructions?: Array<{
        programId?: { toBase58?: () => string } | string;
        program?: string;
        parsed?: { type?: string; info?: Record<string, unknown> } | null;
        // memo program ix carries its data as a string-typed parsed.info or inline `data`.
        data?: string;
      }>;
    };
  } | null;
  meta?: {
    err?: unknown;
  } | null;
};

function ixProgramId(ix: {
  programId?: { toBase58?: () => string } | string;
}): string | null {
  if (typeof ix.programId === 'string') return ix.programId;
  if (ix.programId && typeof ix.programId.toBase58 === 'function') {
    try {
      return ix.programId.toBase58();
    } catch {
      return null;
    }
  }
  return null;
}

/** classify a parsed Solana tx. returns kind + extracted memo when present. */
export function classifySolanaTx(parsed: ParsedTxLite): {
  kind: IndexedTxKind;
  memo: string | null;
  swapMeta?: IndexedTx['swapMeta'];
} {
  const instructions = parsed?.transaction?.message?.instructions ?? [];
  let kind: IndexedTxKind = 'unknown';
  let memo: string | null = null;
  let touchedSwap = false;
  let touchedStake = false;
  let touchedTransfer = false;

  for (const ix of instructions) {
    const pid = ixProgramId(ix);
    if (!pid) continue;
    if (SWAP_PROGRAM_IDS.has(pid)) {
      touchedSwap = true;
    } else if (STAKE_PROGRAM_IDS.has(pid)) {
      touchedStake = true;
    } else if (MEMO_PROGRAM_IDS.has(pid)) {
      // memo data lives on `parsed.info` (when web3.js parsed it as a memo) or on `data`
      // as a base58 / UTF-8 string. memo program v2 returns the UTF-8 directly.
      const directData = typeof ix.data === 'string' ? ix.data : null;
      const parsedInfo = ix.parsed?.info;
      if (typeof parsedInfo === 'string') {
        memo = parsedInfo;
      } else if (directData) {
        // try UTF-8 decode of base58/base64 directly (web3.js encodes memo data as base58
        // for the wire-level `getTransaction`, but we'll commonly see UTF-8 already).
        memo = directData;
      }
    } else if (pid === SOLANA_PROGRAM_IDS.SYSTEM || pid === SOLANA_PROGRAM_IDS.TOKEN) {
      const t = ix.parsed?.type;
      if (t === 'transfer' || t === 'transferChecked') touchedTransfer = true;
    }
  }

  if (touchedSwap) kind = 'swap';
  else if (touchedStake) kind = 'stakeDelegate'; // refinement based on parsed.type later
  else if (touchedTransfer) kind = 'transfer';
  else if (instructions.length > 0) kind = 'smartContractCall';

  return { kind, memo };
}
