/** apply saved home-card order (pure; safe for UI import). */
export function applyDwalletCardOrder<T extends { dwalletId: string }>(caps: T[], savedOrder: string[]): T[] {
  const byId = new Map(caps.map((c) => [c.dwalletId, c]));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const id of savedOrder) {
    const c = byId.get(id);
    if (c && !seen.has(id)) {
      out.push(c);
      seen.add(id);
    }
  }
  const rest = caps.filter((c) => !seen.has(c.dwalletId)).sort((a, b) => a.dwalletId.localeCompare(b.dwalletId));
  out.push(...rest);
  return out;
}
