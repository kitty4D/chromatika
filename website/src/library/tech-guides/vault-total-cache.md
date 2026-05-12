# vault-total-cache

per-vault USD aggregate cache stored in `chrome.storage.session`. SWR (stale-while-revalidate) pattern with a 5-minute TTL. provides the number shown in `<VaultTotalLine>` at the top of the wallet home screen.

## storage

key: `chromatika_vault_total_v1_<vaultId>` in `chrome.storage.session` (lost on browser close, which is fine - it's a cache).

## data model

```ts
type PerChainTotal = {
  chainKey: string;    // e.g. 'evm-1', 'sui-mainnet', 'sol-devnet'
  usdMicros: bigint;   // 1 USD = 1_000_000 micros
  ok: boolean;         // false if the chain fetch failed
  reason?: string;     // error reason when !ok
};

type VaultTotalSnapshot = {
  vaultId: string;
  usdMicros: bigint;     // aggregate across all chains
  partial: boolean;      // true if any chain failed (sum is incomplete)
  lastFetchedMs: number; // Date.now() of last fetch
  perChain: PerChainTotal[];
};
```

## wire format

`chrome.storage` can't serialize `bigint`. the cache serializes `usdMicros` as a string on write (`toWire`) and parses back on read (`fromWire`). `parseStoredWireSnapshot` defensively validates the shape before converting (guards against corrupted storage).

## TTL + staleness

```ts
const VAULT_TOTAL_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

function isStaleSnapshot(snapshot, nowMs): boolean {
  if (!snapshot) return true;
  return nowMs - snapshot.lastFetchedMs > VAULT_TOTAL_CACHE_TTL_MS;
}
```

callers check `isStaleSnapshot` before serving the cached value. if stale, a fresh fetch runs and overwrites the snapshot.

## invalidation

the cache is explicitly cleared on vault lifecycle events that change what the total should reflect:
- `addVault` / `removeVault` / `switchVault` / `importVault`

## UI integration

- `<VaultTotalLine>` reads the cached snapshot and displays the formatted total
- `chromatika_vault_total_format_v1` in `localStorage` stores the user's preferred display format (`'compact' | 'exact'`)

## per-chain fetchers

`services/vault-total-fetchers.ts` runs per-chain balance queries (Sui GraphQL, EVM RPC, Solana RPC, etc.) and returns `PerChainTotal[]`. the orchestrator aggregates into `VaultTotalSnapshot` and writes to cache.

## files

- `src/background/services/vault-total-cache.ts` - read / write / clear / staleness check
- `src/background/services/vault-total-value.ts` - orchestrator
- `src/background/services/vault-total-fetchers.ts` - per-chain balance + price lookups
- `src/background/storage/keys.ts` - `VAULT_SCOPED_KEYS.vaultTotal`

## related

- [price-waterfall-and-sources.md](/library/tech/price-waterfall-and-sources) - where the USD prices come from
- [chrome-storage-local-and-session.md](/library/tech/chrome-storage-local-and-session) - session storage constraints
