/**
 * Known USD-pegged stablecoin symbols, used by the Send token picker's "Stablecoins" filter
 * chip. matching is symbol-only (uppercased) - we don't pin to specific mints / contracts
 * because the same symbol on different chains is operationally the same asset for the user.
 *
 * adding a coin here: only the highest-volume, well-known USD pegs. niche / depegged /
 * algorithmic stables don't qualify (TerraUSD is the cautionary tale). non-USD pegs (EURC,
 * EURS, agEUR) are not in this set; if the product wants per-region pegs later, switch
 * `isStablecoin` to take a peg-currency arg.
 */
export const STABLECOIN_SYMBOLS: ReadonlySet<string> = new Set([
  'USDC',
  'USDT',
  'DAI',
  'BUSD',   // grandfathered; Paxos stopped minting in 2026 but circulating supply persists
  'FDUSD',
  'PYUSD',
  'USDE',   // Ethena USDe
  'TUSD',
  'USDP',   // Paxos Standard
  'GUSD',   // Gemini Dollar
  'LUSD',   // Liquity LUSD
  'SUSD',   // Synthetix sUSD
  'CRVUSD',
  'MIM',
  'FRAX',
]);

/** symbol-only stablecoin detection. case-insensitive. */
export function isStablecoinSymbol(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return STABLECOIN_SYMBOLS.has(symbol.trim().toUpperCase());
}
