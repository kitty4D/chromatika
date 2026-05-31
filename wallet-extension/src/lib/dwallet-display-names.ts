export type DwalletCurve = 'SECP256K1' | 'ED25519';

/**
 * automatic, non-user-editable chain prefix on every dWallet label. SECP256K1 dWallets
 * sign for evm + btc, ED25519 dWallets sign for sol + sui + apt - the prefix is a curve
 * fact, not a user-controlled string. `resolveDwalletLabel` ALWAYS prepends this even
 * when the user has set a custom suffix; any prefix typed into the rename field is
 * stripped so we don't double-prefix on display.
 */
export function dwalletChainPrefix(curve: DwalletCurve): string {
  return curve === 'SECP256K1' ? '[BTC.EVM]' : '[SOL.SUI.APT]';
}

export function defaultDwalletTitle(curve: DwalletCurve, index1Based: number): string {
  return `${dwalletChainPrefix(curve)} Wallet #${index1Based}`;
}

/** stable 1-based index per curve from caps (sorted `dwalletId`). */
export function buildDwalletIndexMap(
  caps: readonly { dwalletId: string; curve: string }[],
): Map<string, number> {
  const secpIds = caps.filter((c) => c.curve === 'SECP256K1').map((c) => c.dwalletId);
  const edIds = caps.filter((c) => c.curve === 'ED25519').map((c) => c.dwalletId);
  const uniqSorted = (ids: string[]) => [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  const m = new Map<string, number>();
  uniqSorted(secpIds).forEach((id, i) => m.set(id, i + 1));
  uniqSorted(edIds).forEach((id, i) => m.set(id, i + 1));
  return m;
}

/** strip a leading [BTC.EVM] or [SOL.SUI.APT] (case-insensitive) so we can re-add the
 *  canonical prefix without doubling up when a user typed it into the rename field. */
export function stripChainPrefix(name: string): string {
  return name.replace(/^\[(BTC\.EVM|SOL\.SUI\.APT)\]\s*/i, '').trim();
}

export function resolveDwalletLabel(
  dwalletId: string,
  curve: DwalletCurve,
  customNames: Readonly<Record<string, string>>,
  indexMap: Map<string, number>,
  beginner = false,
): string {
  const raw = customNames[dwalletId]?.trim();
  const cleaned = raw ? stripChainPrefix(raw) : '';
  // beginner tier: drop the [BTC.EVM] / [SOL.SUI.APT] + "Wallet #" jargon. a custom name
  // shows as-is; otherwise the account is named by the chains it holds.
  if (beginner) {
    if (cleaned) return cleaned;
    const group = curve === 'SECP256K1' ? 'Bitcoin + Ethereum' : 'Solana, Sui + Aptos';
    const idx = indexMap.get(dwalletId) ?? 1;
    return idx > 1 ? `${group} ${idx}` : group;
  }
  const prefix = dwalletChainPrefix(curve);
  if (cleaned) return `${prefix} ${cleaned}`;
  const idx = indexMap.get(dwalletId) ?? 1;
  return `${prefix} Wallet #${idx}`;
}
