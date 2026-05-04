/**
 * resolve a soft-policy declared value for an EVM signing request.
 *
 * two main flows:
 *   - **EVM transaction sign**: msgBytes is the RLP-encoded unsigned tx. parse via ethers,
 *     pull the `value` (wei), look up ETH/USD price, return micro-USD value.
 *   - **EVM message sign** (personal_sign / EIP-712): msgBytes is the keccak preimage. no
 *     funds movement. caller passes 0n directly; this helper isn't called.
 *
 * **honest limitation (soft policy v0)**: the helper extracts only `tx.value`, the ETH
 * being moved. ERC-20 / ERC-721 / arbitrary contract calls report value=0 (the ETH leg)
 * and don't count against the daily cap. v1 hard policy in `sign_gate_evm.move` will
 * decode calldata for known patterns (ERC-20 transfer, Uniswap swap, etc.) and price
 * those amounts on-chain.
 *
 * until then, the cap is a "max ETH/day" budget. token transfers slip through with no
 * declared value. document this prominently in user-facing UI so users don't assume their
 * USDC balance is also capped.
 */

import { Transaction } from 'ethers';
import { getPrice } from '@/background/services/price';

/**
 * convert a raw EVM tx's wei value + ETH/USD price to a u64-safe micro-USD value.
 *
 * math: `valueMicros = floor(valueWei * priceMicros / 1e18)`. uses bigint to avoid float
 * precision issues at high wei values.
 *
 * caps the result at u64 max (~1.8e19) since the Move side stores it as u64. a 1.8e19
 * micro-USD cap = $18 trillion, so practical txs won't hit this.
 */
function weiToMicroUsd(valueWei: bigint, priceUsd: number): bigint {
  if (valueWei <= 0n) return 0n;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  // encode price as micro-USD per ETH (price * 1e6).
  const priceMicros = BigInt(Math.round(priceUsd * 1_000_000));
  const valueMicros = (valueWei * priceMicros) / 10n ** 18n;
  const U64_MAX = (1n << 64n) - 1n;
  return valueMicros > U64_MAX ? U64_MAX : valueMicros;
}

/**
 * resolve declared value (in micro-USD) for an unsigned EVM tx. returns 0n on parse
 * failure or zero-value calls.
 */
export async function resolveEvmDeclaredValueMicros(
  unsignedTxBytes: Uint8Array,
): Promise<bigint> {
  try {
    let hex = '';
    for (const b of unsignedTxBytes) hex += b.toString(16).padStart(2, '0');
    const tx = Transaction.from('0x' + hex);
    const valueWei = tx.value;
    if (valueWei === 0n) return 0n;
    const ethPrice = await getPrice('eth');
    return weiToMicroUsd(valueWei, ethPrice);
  } catch (e) {
    console.warn('[chromatika policy-vault] resolveEvmDeclaredValueMicros failed; treating as 0:', e);
    return 0n;
  }
}

/** exposed for unit tests. */
export const __test__ = { weiToMicroUsd };
