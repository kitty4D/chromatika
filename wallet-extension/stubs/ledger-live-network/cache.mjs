// chromatika stub for @ledgerhq/live-network/cache.
//
// the real cache module wraps async functions with an LRU cache (using `lru-cache`).
// chromatika doesn't need the caching since the wrapped functions never get called -
// but `makeLRUCache(...)` IS invoked at module-init time in callers like
// `@ledgerhq/ledger-cal-service/lib/networks.js`, so it must return a callable. we provide
// a passthrough that returns the input async function as-is, with the same `.force /
// .hydrate / .clear / .reset` API surface (all no-ops).
//
// `seconds`, `minutes`, `hours` return cache options used as the third arg to
// `makeLRUCache`; we ignore that arg entirely so any plain object works.

export function seconds(num, max = 100) {
  return { max, ttl: num * 1000 };
}

export function minutes(num, max = 100) {
  return seconds(num * 60, max);
}

export function hours(num, max = 100) {
  return minutes(num * 60, max);
}

export const makeLRUCache = (f, _keyExtractor, _lruOpts) => {
  // passthrough wrapper: just call f directly, no caching.
  const result = (...args) => f(...args);
  result.force = (...args) => f(...args);
  result.hydrate = () => {};
  result.clear = () => {};
  result.reset = () => {};
  return result;
};
