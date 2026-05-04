// chromatika stub for @ledgerhq/live-network/cache (CJS variant) - see cache.mjs for context.

'use strict';

function seconds(num, max = 100) {
  return { max, ttl: num * 1000 };
}

function minutes(num, max = 100) {
  return seconds(num * 60, max);
}

function hours(num, max = 100) {
  return minutes(num * 60, max);
}

const makeLRUCache = (f, _keyExtractor, _lruOpts) => {
  const result = (...args) => f(...args);
  result.force = (...args) => f(...args);
  result.hydrate = () => {};
  result.clear = () => {};
  result.reset = () => {};
  return result;
};

exports.seconds = seconds;
exports.minutes = minutes;
exports.hours = hours;
exports.makeLRUCache = makeLRUCache;
exports.__esModule = true;
