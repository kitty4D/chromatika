import { describe, it, expect } from 'vitest';
import { wouldCreateParentCycle, orderCapsForTree, treeDepthForCap } from '@/lib/dwallet-tree';

describe('wouldCreateParentCycle', () => {
  it('allows null parent', () => {
    expect(wouldCreateParentCycle('a', null, { a: 'b' })).toBe(false);
  });

  it('detects self-loop', () => {
    expect(wouldCreateParentCycle('x', 'x', {})).toBe(true);
  });

  it('detects when proposed parent sits under the child in the current map', () => {
    const g = { b: 'c', c: 'a' };
    expect(wouldCreateParentCycle('a', 'b', g)).toBe(true);
  });

  it('allows attaching to an unrelated cap', () => {
    const g = { b: 'root' };
    expect(wouldCreateParentCycle('a', 'b', g)).toBe(false);
  });
});

describe('orderCapsForTree', () => {
  it('lists parent before nested child', () => {
    const caps = [{ dwalletId: 'child' }, { dwalletId: 'mom' }];
    const order = orderCapsForTree(caps, { child: 'mom' });
    expect(order.map((c) => c.dwalletId)).toEqual(['mom', 'child']);
  });
});

describe('treeDepthForCap', () => {
  const ids = new Set(['a', 'b', 'c']);

  it('returns 0 for root', () => {
    expect(treeDepthForCap('a', { b: 'a' }, ids)).toBe(0);
  });

  it('counts steps up to root', () => {
    expect(treeDepthForCap('b', { b: 'a' }, ids)).toBe(1);
    expect(treeDepthForCap('c', { c: 'b', b: 'a' }, ids)).toBe(2);
  });
});
