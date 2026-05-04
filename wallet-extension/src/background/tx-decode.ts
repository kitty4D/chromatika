/**
 * decodes EVM transaction calldata into human-readable summaries.
 * local 4-byte selector map - no external API calls, works offline.
 */

import { formatUnits } from 'ethers';

const SELECTORS: Record<string, string> = {
  a9059cbb: 'transfer(address,uint256)',
  '095ea7b3': 'approve(address,uint256)',
  '23b872dd': 'transferFrom(address,address,uint256)',
  '70a08231': 'balanceOf(address)',
  a0712d68: 'mint(uint256)',
  '42966c68': 'burn(uint256)',
  e985e9c5: 'isApprovedForAll(address,address)',
  a22cb465: 'setApprovalForAll(address,bool)',
  '42842e0e': 'safeTransferFrom(address,address,uint256)',
  '2e1a7d4d': 'withdraw(uint256)',
  d0e30db0: 'deposit()',
  // uniswap v2
  '38ed1739': 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  '7ff36ab5': 'swapExactETHForTokens(uint256,address[],address,uint256)',
  fb3bdb41: 'swapETHForExactTokens(uint256,address[],address,uint256)',
  '8803dbee': 'swapTokensForExactTokens(uint256,uint256,address[],address,uint256)',
  '791ac947': 'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
  // uniswap v3
  ac9650d8: 'multicall(bytes[])',
  '04e45aaf': 'exactInputSingle(tuple)',
  b858183f: 'exactInput(tuple)',
  '5023b4df': 'exactOutputSingle(tuple)',
  '09b81346': 'exactOutput(tuple)',
  // opensea / seaport
  fb0f3ee1: 'fulfillBasicOrder(tuple)',
  b3a34c4c: 'fulfillOrder(tuple,bytes32)',
  ed98a574: 'fulfillAvailableOrders(tuple[],tuple[][],bytes32,address,uint120)',
  // common utility
  '40c10f19': 'mint(address,uint256)',
  '5d3b1d30': 'stake(uint256)',
  '2e17de78': 'unstake(uint256)',
  a694fc3a: 'stake(uint256)',
  '2def6620': 'unstake()',
  '4e71d92d': 'claim()',
};

export type DecodedTx = {
  to: string;
  /** formatted native value (e.g. "0.01 ETH") */
  valueFormatted: string;
  valueWei: bigint;
  /** recognized function name or null */
  functionName: string | null;
  /** raw 4-byte selector (hex, no 0x) */
  selector: string | null;
  dataLength: number;
  /** true if this looks like a plain ETH transfer */
  isNativeTransfer: boolean;
  /** risk indicators */
  warnings: string[];
};

export function decodeTx(
  to: string | null,
  value: string | bigint | null,
  data: string | null,
  nativeSymbol = 'ETH',
  nativeDecimals = 18,
): DecodedTx {
  const dec = Number.isFinite(nativeDecimals) && nativeDecimals >= 0 && nativeDecimals <= 36 ? nativeDecimals : 18;
  const valueWei = value != null ? BigInt(value) : 0n;
  const dataHex = (data ?? '0x').replace(/^0x/i, '');
  const selector = dataHex.length >= 8 ? dataHex.slice(0, 8).toLowerCase() : null;
  const functionName = selector ? (SELECTORS[selector] ?? null) : null;
  const isNativeTransfer = !dataHex || dataHex === '' || dataHex === '0'.repeat(dataHex.length);

  const valueEth = Number(formatUnits(valueWei, dec));
  const valueFormatted = valueEth === 0
    ? `0 ${nativeSymbol}`
    : `${Number(formatUnits(valueWei, dec)).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 8 })} ${nativeSymbol}`;

  const warnings: string[] = [];
  if (!to) warnings.push('contract deployment (no "to" address)');
  if (selector === 'a22cb465') warnings.push('setApprovalForAll - grants full token control to operator');
  if (selector === '095ea7b3') {
    // check for uint256 max (unlimited approval) - last 32 bytes of data = amount
    const amountHex = dataHex.slice(72); // 8 selector + 64 address = 72
    if (/^f{64}$/i.test(amountHex)) warnings.push('unlimited token approval (max uint256)');
  }
  const oneUnit = 10n ** BigInt(dec);
  if (valueWei > oneUnit) warnings.push(`sending more than 1 ${nativeSymbol} - double check amount`);

  return {
    to: to ?? '(contract deploy)',
    valueFormatted,
    valueWei,
    functionName,
    selector,
    dataLength: dataHex.length / 2,
    isNativeTransfer,
    warnings,
  };
}
