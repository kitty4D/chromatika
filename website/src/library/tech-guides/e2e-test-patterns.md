# e2e test patterns: SW fetch mock + dev-harness flags

chromatika's Playwright e2e suite has three patterns for testing flows that reach into the MV3 service worker, external services, or session state that doesn't exist by default. each pattern is gated on `import.meta.env.DEV` so the mock branches never reach production builds.

## 1. service-worker fetch mock (`mockSwFetch`)

**use case**: a probe / signing / API call runs in the background SW (not the page) and you need to intercept the HTTP request without hitting the real network. examples: DeSo node lookups, Subscan calls, EVM RPC, esplora.

**why not `page.route`**: Playwright's page-level route only catches the page-context fetch. chromatika's scan probes, ika gRPC, and most chain RPCs run from the SW, so page-level routing misses them entirely.

### API

defined in `e2e/fixtures.ts`:

```ts
export async function mockSwFetch(
  worker: Worker,
  pattern: string,
  response: { status: number; body: unknown; headers?: Record<string, string> },
): Promise<void>;

export async function clearSwFetchMocks(worker: Worker): Promise<void>;
```

- **`pattern`**: substring matched against the request URL (e.g. `/api/v0/get-users-stateless`). all matching URLs get the canned response
- **idempotent**: subsequent calls register additional mocks against the same patched fetch
- **fall-through**: URLs that don't match any pattern hit the original fetch (chromatika's real network)

### implementation

`worker.evaluate(...)` runs JS in the SW context. on first call:
1. captures `globalThis.fetch` as `__chromatika_e2e_origFetch`
2. replaces `globalThis.fetch` with a wrapper that checks the URL against a `Map<pattern, response>` before falling through
3. sets `__chromatika_e2e_fetchPatched = true` so subsequent calls just add to the map

`clearSwFetchMocks(worker)` restores the original fetch + clears the map. always call in `afterEach` so specs don't leak fetch state.

### example: scan-deso

```ts
test.afterEach(async ({ backgroundWorker }) => {
  await clearSwFetchMocks(backgroundWorker);
});

test('opting into DeSo + rescanning surfaces the mocked balance row', async ({
  page, extensionId, backgroundWorker,
}) => {
  await mockSwFetch(backgroundWorker, '/api/v0/get-users-stateless', {
    status: 200,
    body: {
      UserList: [{ PublicKeyBase58Check: 'E2E_PLACEHOLDER', BalanceNanos: 1_500_000_000, ProfileEntryResponse: { Username: 'e2e_test_user' } }],
    },
  });

  // ... drive UI flow ... eventually triggers scanForHd which fires the SW fetch ...
  await expect(page.getByText(/DESO\b/i).first()).toBeVisible({ timeout: 30_000 });
});
```

## 2. lazor portal mock harness (`?e2eLazorMock=<scenario>`)

**use case**: testing the lazor seed-source paths (deterministic / non-deterministic / no-pda) without driving a real `portal.lazor.sh` iframe.

### API

URL parameter `e2eLazorMock` on any page that loads `lazor-init.ts`:

- `?e2eLazorMock=deterministic` → `lazorConnect()` returns canned creds, `resolveLazorSmartWalletPda()` returns canned PDA + program id, `lazorDeterminismProbe()` reports `{ deterministic: true, signatureB64 }`
- `?e2eLazorMock=non-deterministic` → same up to the probe, which reports `{ deterministic: false, firstB64, secondB64 }`
- `?e2eLazorMock=no-pda` → `lazorConnect()` succeeds but `resolveLazorSmartWalletPda()` returns `null`
- any other value or unset: real Lazor SDK runs

### implementation

`lazor-init.ts`:

```ts
type LazorMockScenario = 'deterministic' | 'non-deterministic' | 'no-pda';

function readLazorMockScenario(): LazorMockScenario | null {
  if (!import.meta.env.DEV) return null;
  if (typeof window === 'undefined') return null;
  try {
    const v = new URL(window.location.href).searchParams.get('e2eLazorMock');
    if (v === 'deterministic' || v === 'non-deterministic' || v === 'no-pda') return v;
  } catch {}
  return null;
}

export async function lazorConnect(opts) {
  const mock = readLazorMockScenario();
  if (mock !== null) return { publicKey: CANNED_PASSKEY_B64, credentialId: CANNED_CRED_ID, isCreated: true };
  // ... real SDK path ...
}
// same gating in resolveLazorSmartWalletPda + lazorDeterminismProbe
```

### canned values

deterministic shapes so downstream consumers don't choke:
- `passkeyPublicKeyB64`: a syntactically-valid base64 string
- `credentialIdB64`: any string (Lazor portal returns base64 in production)
- `smartWalletPdaB58`: valid base58 32-byte solana pubkey
- `walletStatePdaB58` / `walletDevicePdaB58` / `programIdB58`: valid base58
- `signatureB64` / `signatureB64Other`: valid base64; `Other` is used for the non-deterministic case so the equality check fails

### example: lazor-signature-onboarding spec

```ts
test('deterministic mock: full bootstrap persists vault with seedSource = "lazor-signature"', async ({ page, extensionId }) => {
  await page.goto(`chrome-extension://${extensionId}/onboarding.html?e2eLazorMock=deterministic`, { waitUntil: 'load' });
  // ... walk through LazorStep, type password, click continue ...
  await expect(page.getByRole('heading', { name: /wallet ready/i })).toBeVisible({ timeout: 90_000 });

  // assert the persisted record's seedSource via tRPC
  const ctx = await page.evaluate(async () => {
    const w = window as { chrome?: { runtime?: { sendMessage?: any } } };
    return w.chrome?.runtime?.sendMessage?.({ trpc: { id: 'scanContextForActiveVault', input: undefined, type: 'query' } });
  });
  expect((ctx as any).seedSource).toBe('lazor-signature');
});
```

## 3. synthetic dwallet inventory harness (`?syntheticInventory=<orphans>:<matched>`)

**use case**: testing the orphan-detection UI in `FindMoreAccountsPanel` without seeding real vaults + real on-chain dwallet caps.

### API

URL parameter `syntheticInventory` with format `<orphans>:<matched>` (e.g. `2:1` = 2 orphan caps + 1 matched cap):

- when set + dev mode, `FindMoreAccountsPanel` skips the real `dwalletInventoryForActiveVault` query
- builds a synthetic inventory in-component: 1 sibling vault (`label='default'`, `ikaIndex=0`, `isActive=true`) holding `matched` known dwalletIds; `orphans` additional caps with `matchedVaultId: null`
- `activeVault` is forced to `accountKind: 'passkey'` so the non-HD CTA renders

### implementation

`FindMoreAccountsPanel.tsx`:

```ts
function readSyntheticInventoryFlag(): { orphans: number; matched: number } | null {
  if (!import.meta.env.DEV) return null;
  if (typeof window === 'undefined') return null;
  try {
    const v = new URL(window.location.href).searchParams.get('syntheticInventory');
    if (!v) return null;
    const [orphansStr, matchedStr] = v.split(':');
    const orphans = Number.parseInt(orphansStr ?? '', 10);
    const matched = Number.parseInt(matchedStr ?? '', 10);
    if (!Number.isFinite(orphans) || !Number.isFinite(matched)) return null;
    return { orphans, matched };
  } catch { return null; }
}

useEffect(() => {
  const synthetic = readSyntheticInventoryFlag();
  if (synthetic) {
    setActiveVault({ id: 'synthetic-vault-0', accountKind: 'passkey', baseChain: 'sui', addr: '0xSYNTHETIC...' });
    setInventory(buildSyntheticInventory(synthetic.orphans, synthetic.matched));
    return;
  }
  // ... real load path ...
}, [reloadKey]);
```

### example: sibling-add-inline spec

```ts
test('orphan + matched badges render with the synthetic inventory state', async ({ page, extensionId }) => {
  const q = new URLSearchParams({ dev: '1', unlocked: '1', vaultExists: '1', tab: 'settings', syntheticInventory: '2:3' });
  await page.goto(`chrome-extension://${extensionId}/side_panel.html?${q.toString()}`, { waitUntil: 'domcontentloaded' });

  await expect(page.getByText(/2 orphans?/i).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/\(idx 0\)/i).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/· orphan/i).first()).toBeVisible({ timeout: 5_000 });
});
```

## general patterns

### dev harness query params (existing)

chromatika's dev mode supports several query params on `side_panel.html` / `onboarding.html`:

- `dev=1` — opt into dev harness
- `unlocked=1` — assume the wallet is unlocked
- `vaultExists=1` — assume `walletExists() === true`
- `tab=<settings|ikaStake|...>` — navigate to a specific tab
- `settingsTab=<dapps|...>` — navigate to a specific settings section
- `activeVaultKind=<passkey|...>` — pin the active vault kind for this session
- `txapprove=<id>` — open as the tx-approve popup window
- `passkeyregister=<id>` / `passkeysign=<id>` / `hwsign=<id>` — open as a per-flow popup

use the existing flags before adding new ones. when adding a new harness flag:
1. gate it on `import.meta.env.DEV`
2. read it from `window.location.href` query string
3. document it in this file under "synthetic harness flags"

### tRPC bridge from the page context

specs that need to assert background state (e.g. seedSource of the active vault) reach the tRPC layer via `chrome.runtime.sendMessage` from `page.evaluate`:

```ts
const ctx = await page.evaluate(async () => {
  const w = window as { chrome?: { runtime?: { sendMessage?: any } } };
  if (!w.chrome?.runtime?.sendMessage) return null;
  try {
    return await w.chrome.runtime.sendMessage({
      trpc: { id: '<procedureName>', input: <input or undefined>, type: 'query' | 'mutation' },
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
});
```

caveat: the dev harness must expose `chrome.runtime.sendMessage` to the page context for this to work. specs should soft-skip with an annotation when it's not available — the heading / DOM check usually pins the persist-correctness contract anyway.

### cleanup expectations

- **fetch mocks**: `clearSwFetchMocks` in `afterEach`
- **dev harness flags**: each test isolates via the URL; no cleanup needed
- **vault state**: `fixtures.ts` creates an isolated `userDataDir` per spec via `mkdtempSync` + `chromium.launchPersistentContext` — vault state never leaks between specs

### when to skip vs assert

soft-skip with an annotation when:
- the harness flag isn't honored (synthetic / mock branch missing)
- the dev tRPC bridge isn't exposed
- the UI structure has shifted (e.g. CTA renamed)

**always** include a `test.info().annotations.push(...)` so the soft-skip is visible in the report. don't silently `return` — that hides regressions.

assert when:
- the structural correctness IS the thing we're testing (heading visibility, error message text, persisted vault shape)
- a real network mock is installed and the spec drove an actual flow that should have hit it

## related guides

- [`scan-service-architecture.md`](/library/tech/scan-service-architecture) — the scan service that the SW fetch mock + synthetic inventory harness exercise
- [`session-state-multi-vault.md`](/library/tech/session-state-multi-vault) — the active-vault session state that the synthetic harness fakes