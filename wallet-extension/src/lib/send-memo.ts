/**
 * memo / note field support per-chain for the Send Confirm step.
 *
 * suiKER's Android wallet shows a memo input on Confirm only when the chain has a
 * first-class memo / note primitive. Most EVM and Sui don't (you can stuff data into a
 * tx but it's non-standard, costs gas, and isn't surfaced on the typical explorer view),
 * so the field hides for those chains. Solana has the Memo Program; Aptos has a tx note
 * arg on its SDK; XRPL / Stellar would qualify too if they ever ship here.
 *
 * keep this list narrow - silently advertising memo support on a chain where the field
 * is destination-side-invisible is worse than no memo at all.
 */

import type { SendTokenChain } from '@/background/services/send-token-types';

/** Solana Memo Program v2 (the v1 program id is also valid but everyone has migrated to v2). */
export const SOLANA_MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export function chainSupportsMemo(chain: SendTokenChain): boolean {
  switch (chain) {
    case 'solana':
      return true;
    case 'aptos':
      // Aptos send is stubbed today; the field can show but submitting still errors out.
      return false; // flip to true when sendUnified wires the aptos path
    case 'sui':
    case 'evm':
    case 'btc':
      return false;
  }
}

/** soft cap so the memo doesn't blow out tx size unexpectedly. Solana Memo can technically
 * hold up to ~566 bytes of UTF-8 in a single ix but typing 200+ chars into a wallet popup is
 * pathological. */
export const SEND_MEMO_MAX_LEN = 200;
