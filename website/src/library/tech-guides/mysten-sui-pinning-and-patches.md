# `@mysten/sui` pinning + deduplication

`@mysten/sui` is Mysten's TypeScript SDK for Sui. chromatika **pins it to a specific version** in npm `overrides` (so the app + ika SDK use the same hoisted copy). a runtime wrapper handles GraphQL `getObjects` chunking (no pnpm patch needed). a `postinstall` step removes a nested copy that ika's SDK ships, ensuring runtime resolution converges to the hoisted version.

## the version

`@mysten/sui` is overridden to **`2.16.2`** (was 2.13.2 historically, then 2.16.0). bumping requires:
1. update direct dep in `wallet-extension/package.json`
2. update `overrides` block at root `package.json` and inside `@ika.xyz/sdk` override
3. also pin `@mysten/bcs` in `pnpm.overrides` to whatever sui's `dependencies` declares (currently `2.0.5`) - see the bcs deduplication section below
4. test ika ops still work (the `IkaClient` is built on `client.core.*` from this exact version)

## the npm `overrides` block

```jsonc
// wallet-extension/package.json
{
  "overrides": {
    "@mysten/sui": "2.16.2",
    "@ika.xyz/sdk": {
      "@mysten/sui": "2.16.2"
    },
    "@ledgerhq/live-network": "2.4.3"
  },
  "pnpm": {
    "overrides": {
      "@ledgerhq/live-network": "link:./stubs/ledger-live-network",
      "@types/node": "^22",
      "@mysten/bcs": "2.0.5"
    }
  }
}
```

`overrides` forces transitive deps to use the pinned version. without this, `@ika.xyz/sdk` could pull a different `@mysten/sui` minor version, leading to type incompatibilities at the boundary (e.g. `IkaTransaction` expects Mysten's `Transaction`, but a different Mysten version's class doesn't `instanceof` the same).

## `@mysten/bcs` deduplication

`@mysten/sui@2.16.2` declares `@mysten/bcs: ^2.0.5` but `@ika.xyz/sdk@0.4.1` declares `^2.0.2`, so pnpm installs both 2.0.5 and 2.0.3 as siblings. `BcsType` is a class with `#private` fields so two copies do not unify nominally - `BcsStruct<T>['$inferType']` collapses to `never`, causing `TS2488` / `TS2339` at ika staking and pricing field accesses. top-level `overrides` is too weak to dedupe ika's transitive resolution; `pnpm.overrides` has stronger precedence and forces a single hoisted copy.

## runtime GraphQL `getObjects` chunking (no patch)

chromatika previously used a pnpm patch to chunk `getObjects` calls. all three historical patches (`@mysten/sui@2.13.2`, `@ledgerhq/live-network@2.0.19`, `@ledgerhq/live-network@2.4.3`) have been replaced by version-agnostic alternatives:

- **`@mysten/sui` GraphQL chunking** is now a runtime wrapper at `src/background/sui-client.ts:installGetObjectsChunking`. wraps `client.core.getObjects` so calls are chunked **12 ids per POST** (vs default 50) with **100ms** between chunks - keeps the GraphQL POST body under common ~5000B server limits. applied at every `new SuiGraphQLClient(...)` site; bumping `@mysten/sui` no longer requires patch refresh.
- **`@ledgerhq/live-network`** is replaced by a local stub at `wallet-extension/stubs/ledger-live-network/`, applied via `pnpm.overrides`. upstream ships a top-level `require("https")` that crashes in MV3 service workers; the stub provides no-op exports.

## the postinstall script

after `pnpm install`, a postinstall step removes:
```
node_modules/@ika.xyz/sdk/node_modules/@mysten/
```

reason: Node's resolution algorithm prefers nested `node_modules` over hoisted ones. even with `overrides`, ika's SDK could ship its own nested `@mysten/sui` that shadows the hoisted version. removing the nested copy forces resolution to the hoisted (correct) version.

`pnpm` typically hoists by default but mixed-resolution scenarios still arise. the postinstall is the belt-and-suspenders fix.

## the `npm ls @mysten/sui` weirdness

per CLAUDE.md non-obvious bullet: `npm ls @mysten/sui` may exit `1` / show "invalid" because npm checks against the package's `peerDependencies` constraints, which the override technically violates. **runtime uses one tree** after the postinstall, so this is npm's static check vs override behavior - cosmetic, not a real issue.

## the vite resolve.dedupe

`vite.config.ts` adds `resolve.dedupe: ['@mysten/sui']` to ensure the bundler picks one version even if two land in node_modules during dev:

```ts
export default defineConfig({
  resolve: {
    dedupe: ['@mysten/sui'],
  },
});
```

without this, vite could include two copies in the bundle, breaking `instanceof` checks across the boundary.

## bundle size impact

`@mysten/sui` is large (~500 KB minified). combined with ika SDK + crypto, the **background bundle** is ~8.0 MB, ~2.6 MB gzipped. ika + wasm dominates, with walletconnect + lazor + `@encrypt.xyz/pre-alpha-solana-client` as the next biggest contributors.

cold load of the SW takes a few seconds on slow machines. chromatika displays a "wallet starting" state until the SW is ready.

## bumping `@mysten/sui`

```sh
pnpm install @mysten/sui@<new-version>
# update overrides in wallet-extension/package.json (both top-level overrides + pnpm.overrides)
# update @mysten/bcs in pnpm.overrides to match whatever the new sui version declares
pnpm install
# postinstall removes the nested @mysten under @ika.xyz/sdk/node_modules
```

then test ika ops + Sui sends + NFT reads. no patch refresh needed (runtime wrapper handles chunking).

## the IkaClient binding

ika's `IkaClient` 0.3.x runs on `client.core.*` from `@mysten/sui` 2.x. chromatika constructs:
```ts
const ikaClient = new IkaClient({ suiClient: suiGraphQLClient });
```

passing chromatika's vault-shared `SuiGraphQLClient`. ika's internal calls go through this client → through the patched `getObjects` chunking → through GraphQL.

## library

- `@mysten/sui` 2.16.2 (pinned)
- `@mysten/bcs` 2.0.5 (pinned via `pnpm.overrides`)
- `@ika.xyz/sdk` 0.4.x (uses pinned mysten via override)
- internal: `wallet-extension/postinstall.mjs` for the nested copy removal
- internal: `src/background/sui-client.ts:installGetObjectsChunking` for runtime chunking

## related

- [sui-graphql-client.md](/library/tech/sui-graphql-client) - the patched client
- [2pc-mpc-overview.md](/library/tech/2pc-mpc-overview) - the ika SDK that builds on it
- [ika-dkg-flow.md](/library/tech/ika-dkg-flow), [ika-presign-pool-impl.md](/library/tech/ika-presign-pool-impl), [ika-sign-flow.md](/library/tech/ika-sign-flow) - ika ops over the patched client
