/**
 * raw balance strings from Sui GraphQL (`getBalance`) are base units (MIST for SUI).
 */

/** MIST string -> SUI float (9 decimals). */
export function suiFromMist(raw: string): number {
  try {
    return Number(BigInt(raw.split('.')[0]!)) / 1e9;
  } catch {
    return parseFloat(raw) || 0;
  }
}

/** IKA coin on Sui uses the same 9-decimal pattern in practice; swap if coin metadata differs. */
export function ikaFromBaseUnits(raw: string): number {
  try {
    return Number(BigInt(raw.split('.')[0]!)) / 1e9;
  } catch {
    return parseFloat(raw) || 0;
  }
}

export function formatUsd(n: number): string {
  if (n >= 1_000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(4);
}
