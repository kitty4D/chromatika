/**
 * Sui tx classifier. PTBs can carry arbitrary commands; we infer kind from the
 * balance-changes + coin-type information the walker already pulls.
 *
 * Phase 2 limitations:
 *   - we don't yet pull `commands { kind moveCall }` in the walker GraphQL query,
 *     so we can't directly detect ika-stake / DEX module calls. Classification today
 *     leans on balance-change patterns (positive coinType change for a different
 *     coinType than the spent one = swap; only one coinType moves = transfer).
 *   - NFT detection requires Display schema introspection that's expensive at index
 *     time; for now NFTs fall under `transfer` until we expand the walker query.
 *
 * When the walker query is extended (Phase 2.1), this classifier gets a richer signal
 * to work with - the public API stays the same.
 */

import type { IndexedTx, IndexedTxKind } from '@/background/services/activity-index';

/** known DEX module prefixes on Sui mainnet. matched as `${package}::${module}` against
 * the walker's extracted MoveCall list. We don't pin function name - any function in
 * these modules counts as a swap (e.g. Cetus `pool::swap` / `pool::swap_with_partner` /
 * `pool::swap_a2b`). */
export const KNOWN_SUI_SWAP_MODULES: ReadonlySet<string> = new Set([
  '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool', // Cetus
  '0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c::router', // Aftermath
  '0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool', // Turbos
  '0xc4049b2d1cc0f6e017fda8260e4377cecd236bd7f56a54fee120816e3c89fd0f::router', // Aftermath aggregator
]);

/** known stake module prefixes - matched as `${package}::${module}`. ika system staking
 * lives at the ika package + `ika_system` module; Sui native validators use `0x3::sui_system`. */
export const KNOWN_SUI_STAKE_MODULES: ReadonlySet<string> = new Set([
  '0x3::sui_system', // Sui native validator staking
  // ika system (specific package pinned per deployment; this is the mainnet ika system addr at time of writing)
]);

/** match for ika-system stake functions. ika's package address may be more variable than
 * sui's hardcoded 0x3, so use a function-name allowlist as a softer match. */
const IKA_STAKE_FUNCTIONS: ReadonlySet<string> = new Set([
  'request_add_stake',
  'request_add_stake_non_entry',
  'request_add_stake_mul_coin',
]);
const IKA_UNSTAKE_FUNCTIONS: ReadonlySet<string> = new Set([
  'request_withdraw_stake',
  'request_withdraw_stake_non_entry',
]);

export type SuiMoveCallSummary = {
  package: string | null;
  module: string | null;
  functionName: string | null;
};

export type SuiClassifierHints = {
  /** Move-call summaries extracted from the PTB commands. empty array when the tx is not
   * a programmable tx (rare) or when the walker query didn't return commands. */
  moveCalls?: SuiMoveCallSummary[];
};

/** classify a Sui IndexedTx using the metadata the walker stored. */
export function classifySuiTx(
  row: IndexedTx,
  hints?: SuiClassifierHints,
): {
  kind: IndexedTxKind;
  swapMeta?: IndexedTx['swapMeta'];
} {
  void row; // row.amountRaw / counterparty are populated; classifier stays signature-stable for future hooks
  const calls = hints?.moveCalls ?? [];
  if (calls.length === 0) {
    // No moveCalls = either splitCoins/transferObjects only OR walker didn't extract.
    // Default to 'transfer' - safest assumption when the tx has no contract interactions.
    return { kind: 'transfer' };
  }

  for (const c of calls) {
    if (!c.package || !c.module) continue;
    const moduleKey = `${c.package}::${c.module}`;
    if (KNOWN_SUI_SWAP_MODULES.has(moduleKey)) {
      return { kind: 'swap' };
    }
    if (KNOWN_SUI_STAKE_MODULES.has(moduleKey)) {
      // refine stake direction by function name when available.
      if (c.functionName && IKA_UNSTAKE_FUNCTIONS.has(c.functionName)) {
        return { kind: 'stakeWithdraw' };
      }
      return { kind: 'stakeDelegate' };
    }
    // ika system fallback: package addr is variable but function names are stable.
    if (c.functionName && IKA_STAKE_FUNCTIONS.has(c.functionName)) {
      return { kind: 'stakeDelegate' };
    }
    if (c.functionName && IKA_UNSTAKE_FUNCTIONS.has(c.functionName)) {
      return { kind: 'stakeWithdraw' };
    }
  }

  // had moveCalls but didn't match anything we know - generic contract call.
  return { kind: 'smartContractCall' };
}
