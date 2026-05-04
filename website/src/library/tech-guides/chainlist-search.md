# Chainlist search

Chainlist (`chainlist.org`) maintains a community-curated list of EVM chains with their RPC URLs, chain IDs, native currency info, and explorer URLs. chromatika doesn't depend on Chainlist's frontend - it queries the underlying JSON data ([chainlist.org/chains.json](https://chainlist.org/chains.json) or the `chainid.network/chains.json` source) for the wallet UI's "search and import" feature.

## how chromatika uses it

`importFromChainlist({ query })` lets the user search by chain name (string) or chain id (number) and get matching candidate networks back. the user picks one, then chromatika commits it via `addCustomNetwork` after validation.

## the search

```ts
async function importFromChainlist({ query }: { query: string | number }) {
  const all = await fetchChainlist();   // cached
  const candidates = all.filter(c => {
    if (typeof query === 'number') return c.chainId === query;
    const q = query.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      c.shortName.toLowerCase().includes(q) ||
      c.chainId.toString() === q
    );
  });
  return candidates.slice(0, 20).map(simplify);
}
```

returns up to 20 matches. each carries:
- `chainId` (decimal)
- `name`, `shortName`
- `nativeCurrency` (`{ name, symbol, decimals }`)
- `rpc` (array of RPC URLs - we usually pick the first that doesn't require an API key)
- `explorers` (array of `{ name, url, standard }`)

## the underlying data source

```
https://chainid.network/chains.json
```

a regularly-updated JSON of every EVM chain ever registered. ~1 MB; chromatika caches in memory after first fetch. refreshed on: explicit user action ("refresh chainlist") or once per session.

## what chromatika does **not** do with this data

- doesn't auto-add chains. the user picks from the search results, then chromatika runs the standard `addCustomNetwork` validation (probe `eth_chainId` against the RPC, reject mismatch)
- doesn't persist the full Chainlist locally. only the chains the user explicitly adds end up in `chromatika_custom_networks_v1`
- doesn't trust Chainlist URLs without verification. several chains have multiple RPC entries; some are stale or rate-limited

## the validation when the user commits

after `importFromChainlist` shows candidates, the user picks one. chromatika then:

```ts
async function addCustomNetwork(params) {
  // probe the suggested RPC
  const provider = new ethers.JsonRpcProvider(params.rpcUrl);
  const probedChainId = await provider.send('eth_chainId', []);
  if (parseInt(probedChainId, 16) !== params.chainId) {
    throw new Error('RPC reports different chainId than declared');
  }
  // commit
  await chrome.storage.local.update('chromatika_custom_networks_v1', list => [...list, params]);
}
```

step 2 catches both:
- malicious RPC lying about which chain it serves
- a stale Chainlist entry pointing at an RPC that's been repurposed

## RPC selection

Chainlist often lists 5+ RPC URLs per chain. chromatika prefers:
1. URLs that look like they don't require an API key (no `${INFURA_API_KEY}` placeholders)
2. URLs that don't have placeholder patterns (`${ALCHEMY_API_KEY}`, etc.)
3. URLs hosted by chain teams themselves (e.g. `arb1.arbitrum.io/rpc` for Arbitrum)
4. fallback to public RPC services (`drpc.org`, `1rpc.io`, etc.)

if all top candidates need API keys, the user has to provide one or pick a public alternative.

## the EIP-3085 vs Chainlist split

EIP-3085 lets a **dapp** suggest a chain (see [eip-3085-3326.md](/library/tech/eip-3085-3326)). Chainlist is the **user-driven** version - the user searches a curated list rather than getting a parameter set from a dapp.

both end at the same `addCustomNetwork` validation. the difference is who initiates the suggestion.

## library

- `fetch` (browser native)
- `ethers` v6 `JsonRpcProvider` for the validation probe
- internal: `wallet-extension/src/background/chains/chainlist.ts` for `fetchChainlist`, `importFromChainlist`
- internal: `wallet-extension/src/background/chains/evm-network.ts` for `addCustomNetwork`

## related

- [eip-3085-3326.md](/library/tech/eip-3085-3326) - the dapp-driven equivalent
- [add-custom-network.md](/library/user/add-custom-network) (user-guides) - the user-facing search flow
- [manage-networks.md](/library/user/manage-networks) (user-guides) - the broader network management surface
