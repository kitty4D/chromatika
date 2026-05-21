export type VerificationLevel = 'verified' | 'unverified' | 'suspicious';

type CachedVerification = { level: VerificationLevel; fetchedAtMs: number };

const cache = new Map<string, CachedVerification>();
const CACHE_TTL_MS = 10 * 60_000;

let jupiterVerifiedMints: Set<string> | null = null;
let jupiterFetchedAt = 0;

const KNOWN_VERIFIED_SYMBOLS = new Set([
  'ETH', 'BTC', 'SOL', 'SUI', 'APT', 'BNB', 'AVAX', 'POL', 'MATIC',
  'USDC', 'USDT', 'DAI', 'WETH', 'WBTC', 'IKA',
]);

async function loadJupiterList(): Promise<Set<string>> {
  if (jupiterVerifiedMints && Date.now() - jupiterFetchedAt < 30 * 60_000) return jupiterVerifiedMints;
  try {
    const r = await fetch('https://token.jup.ag/strict', { signal: AbortSignal.timeout(6_000) });
    if (!r.ok) return jupiterVerifiedMints ?? new Set();
    const data = await r.json() as Array<{ address: string }>;
    jupiterVerifiedMints = new Set(data.map((t) => t.address));
    jupiterFetchedAt = Date.now();
    return jupiterVerifiedMints;
  } catch {
    return jupiterVerifiedMints ?? new Set();
  }
}

export type VerificationItem = { chain: string; identifier: string };

export async function getTokenVerificationBatch(
  items: VerificationItem[],
): Promise<Record<string, VerificationLevel>> {
  const result: Record<string, VerificationLevel> = {};
  const toFetch: VerificationItem[] = [];

  for (const item of items) {
    const key = `${item.chain}:${item.identifier}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.fetchedAtMs < CACHE_TTL_MS) {
      result[key] = hit.level;
    } else {
      toFetch.push(item);
    }
  }

  if (toFetch.length === 0) return result;

  const jupMints = await loadJupiterList();

  for (const item of toFetch) {
    const key = `${item.chain}:${item.identifier}`;
    let level: VerificationLevel = 'unverified';

    if (item.chain === 'native' && KNOWN_VERIFIED_SYMBOLS.has(item.identifier.toUpperCase())) {
      level = 'verified';
    } else if (item.chain === 'solana' && jupMints.has(item.identifier)) {
      level = 'verified';
    } else if (item.chain === 'evm' && KNOWN_VERIFIED_SYMBOLS.has(item.identifier.toUpperCase())) {
      level = 'verified';
    } else if (item.chain === 'sui' && item.identifier.toUpperCase() === 'SUI') {
      level = 'verified';
    }

    cache.set(key, { level, fetchedAtMs: Date.now() });
    result[key] = level;
  }

  return result;
}
