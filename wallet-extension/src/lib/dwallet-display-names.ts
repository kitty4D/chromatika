export type DwalletCurve = 'SECP256K1' | 'ED25519';

export function defaultDwalletTitle(curve: DwalletCurve, index1Based: number): string {
  if (curve === 'SECP256K1') return `[BTC.EVM] Wallet #${index1Based}`;
  return `[SOL.SUI.APT] Wallet #${index1Based}`;
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

export function resolveDwalletLabel(
  dwalletId: string,
  curve: DwalletCurve,
  customNames: Readonly<Record<string, string>>,
  indexMap: Map<string, number>,
): string {
  const raw = customNames[dwalletId]?.trim();
  if (raw) return raw;
  const idx = indexMap.get(dwalletId) ?? 1;
  return defaultDwalletTitle(curve, idx);
}
