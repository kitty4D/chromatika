/**
 * order owned caps for tree display using optional parent pointers (child -> parent).
 */

export type CapLike = { dwalletId: string };

/** true if assigning `parentId` as parent of `childId` would create a cycle (including self-loop). */
export function wouldCreateParentCycle(
  childId: string,
  parentId: string | null,
  parentByChild: Record<string, string>,
): boolean {
  if (!parentId) return false;
  if (parentId === childId) return true;
  const seen = new Set<string>();
  let walk: string | null = parentId;
  while (walk) {
    if (walk === childId) return true;
    if (seen.has(walk)) break;
    seen.add(walk);
    walk = parentByChild[walk] ?? null;
  }
  return false;
}

/** roots = no parent or parent not in this vault's cap list. pre-order DFS. */
export function orderCapsForTree<T extends CapLike>(caps: T[], parentByChild: Record<string, string>): T[] {
  const idSet = new Set(caps.map((c) => c.dwalletId));
  const childrenByParent = new Map<string, T[]>();
  for (const c of caps) {
    const p = parentByChild[c.dwalletId];
    const parentKey = p && idSet.has(p) ? p : '__root__';
    if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
    childrenByParent.get(parentKey)!.push(c);
  }
  const out: T[] = [];
  function walk(parentKey: string) {
    for (const c of childrenByParent.get(parentKey) ?? []) {
      out.push(c);
      walk(c.dwalletId);
    }
  }
  walk('__root__');
  for (const c of caps) {
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** steps up parent pointers until root or unknown id (depth of nested UX indent). */
export function treeDepthForCap(dwalletId: string, parentByChild: Record<string, string>, idSet: Set<string>): number {
  let d = 0;
  let cur = dwalletId;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const p = parentByChild[cur];
    if (!p || !idSet.has(p) || p === cur) break;
    d += 1;
    cur = p;
    if (d > 64) break;
  }
  return d;
}
