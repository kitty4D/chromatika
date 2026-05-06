# activity scan service architecture

chromatika's scan service answers two questions during onboarding / restore:

1. **which derivation slots have on-chain history?** (BIP44 account index for HD; ika encryption-key index isn't address-changing for passkey/seeker/waap/lazor — those are scoped via the post-unlock inventory match)
2. **what activity exists on each candidate's addresses?** balance + tx count across Sui mainnet + Solana mainnet + Solana devnet by default, plus opt-in super-pro chains

three modules under `wallet-extension/src/background/scan/` plus a tRPC router. all background-side; the UI consumes the result.

## module layout

```
src/background/scan/
  scan-types.ts              # contracts (ScanInput / ScanCandidate / ChainProbe / ScanResult)
  scan-derivations.ts        # candidate generation per method
  scan-probes.ts             # per-chain probe builders (sui/sol/evm/btc/aptos/deso/cosmos/polkadot)
  scan-orchestrator.ts       # runs probes, gap-limit search, dwallet cap counting
  dwallet-cap-match.ts       # pure helper for orphan detection (post-unlock inventory)
src/server/routers/scan.ts   # tRPC mutations (scanForHd / scanForPasskey / ... + dwalletInventoryForActiveVault)
src/config/scan-chains.ts    # super-pro chain registry (ScanChainEntry union + per-kind catalogs)
src/ui/scan/ScanResultsView.tsx        # rendering candidates + super-pro picker + import button
src/ui/settings/FindMoreAccountsPanel.tsx  # post-unlock entry; mounts inline WalletSetupFlow
src/ui/wallet-setup-flow/steps/import.tsx # advanced HD scan toggle + multi-account import
```

## core types

```ts
type ScanMethod = "passkey" | "hd" | "seeker" | "waap" | "lazor";

type ScanInput =
  | { method: "hd"; mnemonic: string; gap?: ScanGapLimits }
  | { method: "passkey"; suiAddress: string }
  | { method: "seeker"; solanaAddress: string }
  | { method: "waap"; suiAddress: string }
  | { method: "lazor"; lazorSmartWalletPubkeyB58: string };

type ScanCandidate = {
  key: string; // unique row key
  accountIndex?: number; // HD only
  suiAddress?: string;
  solanaAddress?: string;
  evmAddress?: string; // HD only
  secp256k1CompressedHex?: string; // HD only; powers DeSo + Cosmos probes
  polkadotEd25519PubkeyHex?: string; // HD only; powers SS58 probe
};

type ChainProbe = {
  chainId: string;
  chainName: string;
  kind: "sui" | "solana" | "evm" | "bitcoin" | "aptos" | "deso" | "cosmos" | "polkadot";
  addressFor: (c: ScanCandidate) => string | undefined;
  probe: (address: string) => Promise<Omit<ScanProbeResult, "chainId" | "chainName" | "address">>;
};

type ScanResult = {
  method: ScanMethod;
  rows: ScanCandidateRow[];
  suggestedKeys: string[];
  elapsedMs: number;
  warnings: string[];
  notes: string[]; // setup-time notes (e.g. lazor placeholder PDA detected)
};
```

## candidate generation (`scan-derivations.ts`)

`buildCandidates(input, gap)` dispatches on method:

- **HD**: `buildHdCandidates(mnemonic, opts)` derives `hardLimit + gap` candidates (default 25 = 20 hard limit + 5 gap). For each `accountIndex i`:
  - Sui Ed25519 keypair via `deriveSuiKeypair(mnemonic, i)` → `suiKp.toSuiAddress()`
  - Solana Ed25519 keypair via `deriveSolanaKeypair(mnemonic, i)` → `solKp.publicKey.toBase58()`
  - EVM via ethers `HDNodeWallet.fromSeed(seed).derivePath("44'/60'/${i}'/0/0")` → `kid.address` + `kid.signingKey.compressedPublicKey` (33-byte hex)
  - Polkadot via `slip10Ed25519DerivePath("m/44'/354'/${i}'/0'/0'", seedHex)` → `Keypair.fromSeed(...)` → 32-byte hex
- **Identity-bound** (passkey / seeker / waap / lazor): single candidate carrying the fixed identity address. defensive base58 validation on solana addresses (`isValidSolanaBase58Address`) so lazor v1 placeholder-PDA records don't trip the solana probe with `Non-base58 character`

## probes (`scan-probes.ts`)

each probe is a small factory `make{Sui,Solana,Evm,Bitcoin,Aptos,Deso,Cosmos,Polkadot}Probe(net)` returning `ChainProbe`. they share a few patterns:

- **lazy connection caching**: `_suiClientByRegistryId` / `_solConnByCluster` / `_evmProviderByChainId` Maps; multiple candidates reuse one client per chain
- **balance-display helper**: `lamportsToDisplay(lamports, decimals, symbol)` — handles fractional rendering uniformly
- **error semantics**: `Promise.allSettled` for parallel balance + tx queries; rejection messages get joined into `error` on the result; `hasActivity` derived from any positive signal
- **defensive validation**: lazor `addressFor` returns `undefined` when the candidate's solana address isn't valid base58, so the probe is skipped instead of throwing

probe-by-probe summaries:

- **sui**: `client.getBalance({ owner, coinType: SUI_TYPE })` + `queryTransactionBlocksGraphQL(client, { filter: { affectedAddress }, limit: 1 })`. tx count capped at 1 (just an existence check)
- **solana**: `connection.getBalance(pubkey, 'confirmed')` + `connection.getSignaturesForAddress(pubkey, { limit: 1 })`. uses `BUILTIN_SOLANA` registry RPC URLs (Helius via `VITE_HELIUS_KEY` when set)
- **evm**: `provider.getBalance(addr)` + `provider.getTransactionCount(addr)` via ethers `JsonRpcProvider` with `staticNetwork: true` to skip the chainId round-trip
- **bitcoin**: esplora `/address/{addr}` returns `{ chain_stats, mempool_stats }` with `funded_txo_sum` / `spent_txo_sum` / `tx_count`
- **aptos**: `/accounts/{addr}/resource/0x1::coin::CoinStore<...AptosCoin>` for balance + `/accounts/{addr}/transactions?limit=1` for activity
- **deso**: chromatika's existing `getUsersStateless([address])` from `deso-node-client` (reads `chromatika_deso_node_v1` chrome.storage). encodes the candidate's `secp256k1CompressedHex` as a `BC1Y...` mainnet (or `tBC1...` testnet) address via `encodeDeSoAddress`
- **cosmos**: `/cosmos/bank/v1beta1/balances/{addr}` (any denom = activity, native parsed for display) + `/cosmos/auth/v1beta1/accounts/{addr}` (sequence number = outgoing tx count). HRP-driven; one entry per chain in `SUPER_PRO_COSMOS`
- **polkadot**: Subscan REST `POST /api/scan/account` with `{ key: address }`. envelope-checked (`code === 0`), balance string parsed via per-chain `nativeDecimals`, `count_extrinsic` (or `nonce` fallback) as tx count. encodes `polkadotEd25519PubkeyHex` via `encodeSs58Address` with the chain's `ss58Prefix`

## chain registry (`scan-chains.ts`)

one discriminated union, one entry per chain:

```ts
type ScanChainEntry =
  | { kind: "evm"; id; name; chainId; rpcUrl; symbol; explorerUrl? }
  | { kind: "bitcoin"; id; name; esploraUrl; cluster: "mainnet" | "signet" | "testnet3" }
  | { kind: "aptos"; id; name; rpcUrl; cluster: "mainnet" | "testnet" }
  | { kind: "deso"; id; name; cluster: "mainnet" | "testnet" }
  | { kind: "cosmos"; id; name; restUrl; bech32Hrp; nativeDenom; nativeDecimals; nativeSymbol }
  | { kind: "polkadot"; id; name; subscanApiUrl; ss58Prefix; nativeDecimals; nativeSymbol };

const SUPER_PRO_CHAINS: ScanChainEntry[] = [
  ...SUPER_PRO_EVM,
  ...SUPER_PRO_BITCOIN,
  ...SUPER_PRO_APTOS,
  ...SUPER_PRO_DESO,
  ...SUPER_PRO_COSMOS,
  ...SUPER_PRO_POLKADOT,
];
```

`buildSuperProProbes(chainIds)` filters `SUPER_PRO_CHAINS` against the user's selection and dispatches each entry to its `make{Kind}Probe(net)` factory. unknown ids are silently skipped — keeps the UI free to grow new chains without backend errors.

`BUILTIN_EVM` (in `src/config/networks.ts`) is the wallet-grade EVM list (Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, Monad, Ink). The orchestrator loads probes for those by default when `defaults: true`. `SUPER_PRO_EVM` is the long-tail (zkSync, Linea, Scroll, Blast, Mantle, Unichain, IoTeX, Bitlayer, Abstract, HyperEVM, MegaETH, ApeChain, Soneium, Tempo) — only loaded when the user opts in.

## orchestrator (`scan-orchestrator.ts`)

```ts
async function runScan(input, chains, gap): Promise<ScanResult> {
  const t0 = Date.now();
  const probes = []; if (chains.defaults) probes.push(...buildDefaultProbes());
  if (chains.superProChainIds?.length) probes.push(...buildSuperProProbes(chains.superProChainIds));
  const allCandidates = buildCandidates(input, gap);

  // setup-time notes (e.g. lazor placeholder PDA detected -> solana probes will skip)
  const notes = [];
  if (input.method === 'lazor' && allCandidates[0]?.solanaAddress === undefined) notes.push(...);

  const rows = [];
  let consecutiveEmpty = 0; let lastHitIdx = -1;
  for (let i = 0; i < allCandidates.length; i++) {
    const c = allCandidates[i];
    const [probeResults, dwalletCount] = await Promise.all([
      probeOne(c, probes, warnings),
      c.suiAddress ? countOwnedDwalletCaps(c.suiAddress) : Promise.resolve(0),
    ]);
    const row = { candidate: c, probes: probeResults, dwalletCount, hasAnyActivity: ..., isDefaultSlot: (c.accountIndex ?? 0) === 0 };
    rows.push(row);
    if (input.method === 'hd') {
      // BIP44 gap-limit search: stop after `accountGap` consecutive empty rows past the last hit.
      // always include up to lastHitIdx + accountGap; default-slot row (index 0) always emitted.
      ...
    }
  }

  return { method: input.method, rows, suggestedKeys, elapsedMs: Date.now() - t0, warnings, notes };
}
```

per-probe execution is `probeOne(candidate, probes, warnings)`:

- builds `Promise.all(probes.map(...))` — concurrent across chains for one candidate
- timeboxes each probe via `withTimeout(promise, PROBE_TIMEOUT_MS=12s, label)`
- captures rejections as warnings + emits a row with `error` set; `hasActivity: false`

HD candidates run sequentially (gap-limit needs prior-row hit/miss state); identity-bound methods have a single candidate.

## dwallet cap counting + matching

at scan time the orchestrator counts owned `DWalletCap` objects for each candidate's sui address via a flat graphql query against sui mainnet (`countOwnedDwalletCaps`). this is a quick existence signal — count only, no per-cap match.

post-unlock, the **precise per-cap match** runs via `dwalletInventoryForActiveVault` tRPC + `matchCapsToSiblings` pure helper:

```ts
matchCapsToSiblings(caps, siblings): { caps: MatchedCap[], capCount, siblingCount, orphanCount }
```

each sibling carries a `knownDwalletIds: string[]` derived from its merged `dwalletMeta` (vault blob + chrome.storage overlay). caps whose `dwalletId` is in any sibling's set get annotated with `matchedVaultId` / `matchedVaultLabel` / `matchedIkaIndex`; unmatched caps are orphans. tested in 9 unit cases in `dwallet-cap-match.test.ts`.

## tRPC surface (`routers/scan.ts`)

flat namespace at the wire level, one mutation per method + a few queries:

- `scanListSuperProChains: query()` — returns `SUPER_PRO_CHAINS` for the picker UI
- `dwalletInventoryForActiveVault: query()` — full inventory + cap-match for the active vault
- `scanContextForActiveVault: query()` — minimal context (`accountKind` / `baseChain` / `suiAddress?` / `solanaAddress?` / `seedSource?`) for the panel header + e2e assertions
- `scanForHd: mutation({ mnemonic, defaults, superProChainIds?, accountIndexGap?, maxIndexHardLimit? })`
- `scanForPasskey: mutation({ suiAddress, defaults, superProChainIds? })`
- `scanForSeeker: mutation({ solanaAddress, defaults, superProChainIds? })`
- `scanForWaap: mutation({ suiAddress, defaults, superProChainIds? })`
- `scanForLazor: mutation({ lazorSmartWalletPubkeyB58, defaults, superProChainIds? })`

## adding a new chain

three patterns, depending on the chain's address shape:

### evm-shaped (chain id + RPC URL + native symbol)

1. **wallet-grade?** add to `BUILTIN_EVM` in `src/config/networks.ts` (chromatika exposes send/receive UI for those)
2. **scan-only?** add to `SUPER_PRO_EVM` in `src/config/scan-chains.ts`
3. nothing else — `makeEvmProbe` handles all evm chains uniformly

### bech32 cosmos-sdk

1. add an entry to `SUPER_PRO_COSMOS`:
   ```ts
   { kind: 'cosmos', id: '<chain-id>', name: '<Display Name>', restUrl: '<https://...>', bech32Hrp: '<hrp>', nativeDenom: '<u_denom>', nativeDecimals: <n>, nativeSymbol: '<SYM>' }
   ```
2. nothing else — HRP + REST shape are the only per-chain variations

### completely new chain shape (TON, etc.)

1. extend `ScanChainEntry` union with a new `kind` variant carrying the chain's specific fields
2. extend `ChainProbe.kind` union in `scan-types.ts` with the new kind
3. add a `make{Kind}Probe(net)` factory in `scan-probes.ts`
4. add a dispatch branch in `buildSuperProProbes`
5. extend `ScanCandidate` with any new pubkey fields if the chain needs a different keypair shape (e.g., `tonAddressShape?`)
6. populate the new field in `buildHdCandidates`
7. write `make{Kind}Probe.test.ts` and address-encode tests

## related guides

- [`webauthn-prf-hmac-secret.md`](/library/tech/webauthn-prf-hmac-secret) — the chromatika constant salt design powering the passkey identity scan
- [`ss58-cosmos-bech32-address-derivation.md`](/library/tech/ss58-cosmos-bech32-address-derivation) — Polkadot SS58 + Cosmos bech32 address derivation
- [`session-state-multi-vault.md`](/library/tech/session-state-multi-vault) — how sibling vaults coexist in one session
- [`e2e-test-patterns.md`](/library/tech/e2e-test-patterns) — SW fetch mock + dev harness flags used by the scan e2e specs
