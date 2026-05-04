/**
 * PC-Token + PC-Swap roadmap pointers. PC-Token is now wired in `@/background/encrypt-pc/`;
 * PC-Swap remains future work (private AMM; ~3+ weeks; tracked in PC_TOKEN.md appendix).
 *
 * the lab tRPC procedures still surface the upstream book URLs so users can read protocol docs
 * before opting into the surface; the actual feature lives in the new `pc-token-flows.ts` +
 * `routers/pc-token.ts` files.
 */

import { assertEncryptSolanaIkaBase } from '@/background/encrypt/encrypt-guard';
import {
  ENCRYPT_PC_SWAP_BOOK_URL,
  ENCRYPT_PC_TOKEN_BOOK_URL,
} from '@/background/encrypt/encrypt-constants';
import {
  getPcTokenProgramIdB58,
  isPcTokenConfigured,
} from '@/background/encrypt-pc/pc-token-program';

export function getEncryptPcTokenPhase3Stub() {
  assertEncryptSolanaIkaBase();
  return {
    status: isPcTokenConfigured() ? ('wired' as const) : ('awaiting_program_id' as const),
    walletObservedPcTokenProgramId: getPcTokenProgramIdB58(),
    bookUrl: ENCRYPT_PC_TOKEN_BOOK_URL,
    note: isPcTokenConfigured()
      ? 'PC-Token wrap / hidden transfer / unwrap flows live at @/background/encrypt-pc/. Wallet UI exposes wrap/send/unwrap on the Portfolio page (Solana rail) and the Send page; markets are managed in Settings → PC-Token markets. See PC_TOKEN.md.'
      : 'PC-Token integration is fully built but no market is configured yet. Add a market in Settings → PC-Token markets with your deployed program ID + SPL mint to wire live. See PC_TOKEN.md.',
  };
}

export function getEncryptPcSwapPhase4Stub() {
  assertEncryptSolanaIkaBase();
  return {
    status: 'optional_after_pc_token' as const,
    bookUrl: ENCRYPT_PC_SWAP_BOOK_URL,
    note: 'PC-Swap (private AMM) is a future slice. ~3+ weeks of work; receipt-gated composability with PC-Token already designed in upstream commit 425567e.',
  };
}
