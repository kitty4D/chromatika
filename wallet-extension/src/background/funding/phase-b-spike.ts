/**
 * phase-b-spike.ts - phase B orchestrator for Sui-native IKA auto-top-up.
 *
 * when FEATURES.PHASE_B_SUI_SWAP is on: exposes swap status, quote, and execute
 * through thin wrappers that the tRPC router calls. when off: returns disabled
 * status and the swap functions throw.
 *
 * the actual DEX integration lives in swap-service.ts (Aftermath REST API).
 */

import { FEATURES } from '@/config/features';
import {
  getSwapStatus as _getSwapStatus,
  getSwapQuote as _getSwapQuote,
  executeSwap as _executeSwap,
  type SwapQuote,
  type SwapResult,
} from './swap-service';

// ---------- status ----------

export interface PhaseBStatus {
  enabled: boolean;
  summary: string;
  /** swap-specific readiness (only populated when enabled + unlocked) */
  swap?: {
    needsSwap: boolean;
    suiBalanceMist: string;
    ikaBalanceBaseUnits: string;
    canSwap: boolean;
    reason: string | null;
  };
}

export async function getPhaseBStatus(): Promise<PhaseBStatus> {
  if (!FEATURES.PHASE_B_SUI_SWAP) {
    return {
      enabled: false,
      summary: 'Phase B (Sui-native IKA top-up) is off. Set VITE_PHASE_B_SUI_SWAP=true to enable.',
    };
  }

  try {
    const swap = await _getSwapStatus();
    const summary = swap.needsSwap
      ? swap.canSwap
        ? 'ready to swap SUI to IKA'
        : `swap blocked: ${swap.reason}`
      : 'IKA balance present - no swap needed';
    return { enabled: true, summary, swap };
  } catch (e) {
    return {
      enabled: true,
      summary: `Phase B enabled but status check failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * backward-compat: the old synchronous stub that router.ts already calls.
 * now delegates to the async version for richer data.
 */
export function getPhaseBSpikeStatus(): { enabled: boolean; summary: string } {
  if (!FEATURES.PHASE_B_SUI_SWAP) {
    return {
      enabled: false,
      summary: 'Phase B (Sui-native IKA top-up) is off. Set VITE_PHASE_B_SUI_SWAP=true to enable.',
    };
  }
  return { enabled: true, summary: 'Phase B active - swap SUI to IKA via Aftermath router.' };
}

// ---------- quote ----------

export async function requestSwapQuote(
  amountInMist?: string,
  slippageBps?: number,
): Promise<SwapQuote> {
  if (!FEATURES.PHASE_B_SUI_SWAP) {
    throw new Error('Phase B swap is not enabled');
  }
  return _getSwapQuote(amountInMist, slippageBps);
}

// ---------- execute ----------

export async function confirmAndExecuteSwap(quoteId: string, quote?: SwapQuote): Promise<SwapResult> {
  if (!FEATURES.PHASE_B_SUI_SWAP) {
    throw new Error('Phase B swap is not enabled');
  }
  return _executeSwap(quoteId, quote);
}
