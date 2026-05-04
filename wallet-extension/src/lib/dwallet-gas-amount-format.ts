/** avoid `toFixed(5)` rounding tiny native balances to 0.00000 (looks empty but rpc returned wei). */
function trimTrailingZeros(s: string): string {
  const t = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return t === '' || t === '-' ? '0' : t;
}

export function formatNativeGasAmountDisplay(amtStr: string): string {
  const x = Number(amtStr.replace(/,/g, ''));
  if (!Number.isFinite(x)) return amtStr;
  if (x === 0) return '0';
  const ax = Math.abs(x);
  if (ax < 1e-12) return x.toExponential(2);
  if (ax < 0.0001) return trimTrailingZeros(x.toPrecision(6));
  if (ax < 1) return trimTrailingZeros(x.toFixed(10));
  if (ax < 1e6) return trimTrailingZeros(x.toFixed(8));
  return x.toExponential(2);
}
