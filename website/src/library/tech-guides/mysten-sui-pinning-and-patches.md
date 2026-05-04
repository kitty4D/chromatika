# `@mysten/sui` pinning + patches

`@mysten/sui` is Mysten's TypeScript SDK for Sui. chromatika **pins it to a specific version** in npm `overrides` (so the app + ika SDK use the same hoisted copy) and **applies a pnpm patch** to chunk GraphQL `getObjects` calls more aggressively. plus a `postinstall` step removes a nested copy that ika's SDK ships, ensuring runtime resolution converges to the hoisted version.

## the version

per agent inventory: `@mysten/sui` is overridden to **`2.16.0`** (was 2.13.2 historically). bumping requires:
1. update direct dep in `wallet-extension/package.json`
2. update `overrides` block at root `package.json` and inside `@ika.xyz/sdk` override
3. refresh the patch (since patch is version-specific)
4. test ika ops still work (the `IkaClient` is built on `client.core.*` from this exact version)

## the npm `overrides` block

```jsonc
// root package.json
{
  "overrides": {
    "@mysten/sui": "2.16.0",
    "@ika.xyz/sdk": {
      "@mysten/sui": "2.16.0"
    },
    "@ledgerhq/live-network": "2.4.3"
  },
  "pnpm": {
    "overrides": {
      "@ledgerhq/live-network": "link:./stubs/ledger-live-network",
      "@types/node": "^22"
    }
  }
}
```

`overrides` forces transitive deps to use the pinned version. without this, `@ika.xyz/sdk` could pull a different `@mysten/sui` minor version, leading to type incompatibilities at the boundary (e.g. `IkaTransaction` expects Mysten's `Transaction`, but a different Mysten version's class doesn't `instanceof` the same).

## the pnpm patch

```
wallet-extension/patches/@mysten__sui@2.13.2.patch
```

(filename has the version pinned; refresh to `@mysten__sui@2.16.0.patch` after the bump.)

what the patch changes:
- `getObjects` and `multiGetObjects` chunk `objectIds` by **12** (instead of upstream's 50)
- 100ms pause between chunks

reason: Sui's GraphQL POST body grows linearly with the id list. a 50-id batch produces a body of ~5000 bytes that hits common edge proxy limits. 12 ids stays well under. 100ms pause reduces burst rate-limit hits.

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

`@mysten/sui` is large (~500 KB minified). combined with ika SDK + crypto, the **background bundle** is ~5.5 MB minified, ~1.6 MB gzipped. ika + wasm dominates. there's no easy way to slim this further without breaking ika protocol support.

cold load of the SW takes a few seconds on slow machines. chromatika displays a "wallet starting" state until the SW is ready.

## the patch refresh dance

bumping `@mysten/sui`:
```sh
pnpm install @mysten/sui@<new-version>
# update overrides in root + wallet-extension package.json
# regenerate the patch:
pnpm patch @mysten/sui@<new-version>
# pnpm extracts the package, opens a temp dir, you edit getObjects to chunk by 12 + add 100ms pause
pnpm patch-commit /path/to/temp-dir
# new patch file lands in patches/
# delete the old patch file
git rm patches/@mysten__sui@<old-version>.patch
git add patches/@mysten__sui@<new-version>.patch
```

then test ika ops + Sui sends + NFT reads. if anything breaks at the patch line, regenerate / debug.

## the IkaClient binding

ika's `IkaClient` 0.3.x runs on `client.core.*` from `@mysten/sui` 2.x. chromatika constructs:
```ts
const ikaClient = new IkaClient({ suiClient: suiGraphQLClient });
```

passing chromatika's vault-shared `SuiGraphQLClient`. ika's internal calls go through this client → through the patched `getObjects` chunking → through GraphQL.

## library

- `@mysten/sui` 2.16.0 (pinned)
- `@ika.xyz/sdk` 0.3.x (uses pinned mysten via override)
- internal: `wallet-extension/postinstall.mjs` (or similar) for the nested copy removal
- internal: `wallet-extension/patches/@mysten__sui@2.16.0.patch` (filename version-suffixed)

## related

- [sui-graphql-client.md](/library/tech/sui-graphql-client) - the patched client
- [2pc-mpc-overview.md](/library/tech/2pc-mpc-overview) - the ika SDK that builds on it
- [ika-dkg-flow.md](/library/tech/ika-dkg-flow), [ika-presign-pool-impl.md](/library/tech/ika-presign-pool-impl), [ika-sign-flow.md](/library/tech/ika-sign-flow) - ika ops over the patched client
