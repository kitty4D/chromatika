/**
 * Procedure path → fixture lookup for the preview trpc-mock.
 *
 * Add an entry here when a screen needs a specific shape. Procedures without an
 * entry log a console warning and resolve to `null`, which most chromatika components
 * tolerate (their loading / empty-state branch fires).
 *
 * Layout-only changes in the wallet do NOT need a fixture update. Only data-shape
 * changes do (e.g. a new field on the Activity row, a new tRPC procedure).
 */

import { getNetworkConfig } from '@ika.xyz/sdk';
import type { IkaValidatorRow } from '@/background/ika/ika-staking';
import { DAVID } from './personas';
import { DEFAULT_EXPLORER_PREFERENCES } from '@/config/explorers';
import { BALANCES_DEFAULT, BALANCES_TOLY } from './balances';
import { NETWORKS } from './networks';
import { ACTIVITY_DAVID } from './activity';
import {
  DWALLET_CAPS_DAVID,
  DWALLET_CAPS_TOLY,
  DWALLET_ADDRESS_BOOK,
  DWALLET_DISPLAY_NAMES,
  DWALLET_CARD_ORDER,
  EVM_TOKEN_BALANCES,
  PORTFOLIO_RAIL_BALANCES_SUI,
  PORTFOLIO_RAIL_BALANCES_SOLANA,
  PORTFOLIO_RAIL_BALANCES_BTC,
  PORTFOLIO_RAIL_BALANCES_APTOS,
  VAULT_SUMMARIES,
} from './dwallets';
import { previewPersistIkaBaseMode, readPreviewIkaBaseMode } from '../preview-local-storage';

type FixtureValue = unknown;
type FixtureFactory = (input: unknown) => FixtureValue;
type FixtureEntry = FixtureValue | FixtureFactory;

// ---- Live mainnet validator fetcher for the preview ----
//
// Mirrors `listIkaValidatorsForSession` in `src/background/ika/ika-staking.ts`. The preview
// build can't reach the real background SW, so we POST the same GraphQL query directly to
// the public Sui mainnet endpoint and parse the `Validator` object JSON identically.
//
// Cached for `MAINNET_VALIDATORS_TTL_MS`; the IkaStakingPage polls every 5min anyway, but
// this guards against re-renders re-fetching during a single session.

const MAINNET_GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';
const MAINNET_VALIDATORS_TTL_MS = 60_000;

let validatorsCache: { at: number; rows: IkaValidatorRow[] } | null = null;
let validatorsInflight: Promise<IkaValidatorRow[]> | null = null;

function parseStatus(state: unknown): IkaValidatorRow['status'] {
  if (typeof state === 'string') {
    if (state === 'Active' || state === 'PreActive' || state === 'Withdrawing') return state;
    return 'Unknown';
  }
  if (state && typeof state === 'object') {
    const obj = state as Record<string, unknown>;
    const variant = typeof obj['@variant'] === 'string' ? (obj['@variant'] as string) : undefined;
    if (variant === 'Active' || variant === 'PreActive' || variant === 'Withdrawing') return variant;
    const kind = typeof obj.$kind === 'string' ? obj.$kind : undefined;
    if (kind === 'Active' || kind === 'PreActive' || kind === 'Withdrawing') return kind;
    if ('Active' in obj) return 'Active';
    if ('PreActive' in obj) return 'PreActive';
    if ('Withdrawing' in obj) return 'Withdrawing';
  }
  return 'Unknown';
}

function toBigIntStr(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return v.toString();
  return '0';
}

function toIntOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number.parseInt(v.trim(), 10);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

async function fetchMainnetValidators(): Promise<IkaValidatorRow[]> {
  const cfg = getNetworkConfig('mainnet');
  const type = `${cfg.packages.ikaSystemOriginalPackage}::validator::Validator`;
  // `asMoveObject.contents.json` is the current Sui GraphQL shape; `asObject.json` (which the
  // background used to use) was rejected by mainnet, hence the previously-empty validator list.
  // Sui GraphQL caps `objects` page size at 50; production currently has ~30 active +
  // a handful of Withdrawing validators, so one page is enough. Bump to cursor pagination
  // if the active set ever pushes past 50.
  const query = `query IkaValidators($type: String!) {
    objects(filter: { type: $type }, first: 50) {
      nodes { address asMoveObject { contents { json } } }
    }
  }`;
  const res = await fetch(MAINNET_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { type } }),
  });
  if (!res.ok) throw new Error(`mainnet GraphQL ${res.status}`);
  const body = (await res.json()) as {
    data?: {
      objects?: {
        nodes?: Array<{
          address?: string;
          asMoveObject?: { contents?: { json?: Record<string, unknown> | null } | null } | null;
        }>;
      };
    };
  };
  const nodes = body.data?.objects?.nodes ?? [];
  const rows: IkaValidatorRow[] = [];
  for (const n of nodes) {
    const addr = n.address;
    if (!addr) continue;
    const j = (n.asMoveObject?.contents?.json ?? {}) as Record<string, unknown>;
    const info = (j.validator_info ?? {}) as Record<string, unknown>;
    const rewardsPool = (j.rewards_pool ?? {}) as { value?: unknown };
    const commission = (j.commission ?? {}) as { value?: unknown };
    const name =
      typeof info.name === 'string' && info.name.length > 0
        ? info.name
        : typeof (j as { name?: string }).name === 'string'
          ? String((j as { name: string }).name)
          : addr.slice(0, 12);
    const status = parseStatus(j.state);
    const commissionRateRaw =
      typeof j.commission_rate === 'number' ? j.commission_rate : toIntOrNull(j.commission_rate);
    rows.push({
      objectId: addr,
      validatorId: addr,
      name,
      status,
      totalStakeBaseUnits: toBigIntStr(j.ika_balance),
      commissionRateBps: commissionRateRaw ?? 0,
      activationEpoch: toIntOrNull(j.activation_epoch),
      latestEpoch: toIntOrNull(j.latest_epoch),
      rewardsPoolBaseUnits: toBigIntStr(rewardsPool?.value),
      commissionBaseUnits: toBigIntStr(commission?.value),
      numShares: toBigIntStr(j.num_shares),
      ...(typeof info.network_address === 'string' && info.network_address.length > 0
        ? { networkAddress: info.network_address }
        : null),
    });
  }
  return rows;
}

function fetchMainnetValidatorsCached(): Promise<IkaValidatorRow[]> {
  if (validatorsCache && Date.now() - validatorsCache.at < MAINNET_VALIDATORS_TTL_MS) {
    return Promise.resolve(validatorsCache.rows);
  }
  if (validatorsInflight) return validatorsInflight;
  validatorsInflight = fetchMainnetValidators()
    .then((rows) => {
      validatorsCache = { at: Date.now(), rows };
      return rows;
    })
    .catch((err) => {
      console.warn('[chromatika preview] mainnet validators fetch failed', err);
      return validatorsCache?.rows ?? [];
    })
    .finally(() => {
      validatorsInflight = null;
    });
  return validatorsInflight;
}


const REGISTRY: Record<string, FixtureEntry> = {
  // Hooks every wallet-shell screen touches on mount. Without these, screens flash
  // a loading state before settling into the demo content.
  'getIkaBaseMode': () => readPreviewIkaBaseMode(),
  // mirrors prod `network.setIkaBaseMode`: persist ika base + fire storage listeners
  'setIkaBaseMode': (input: unknown) => {
    const mode = (input as { mode?: unknown })?.mode === 'solana' ? 'solana' : 'sui';
    previewPersistIkaBaseMode(mode);
    return undefined;
  },
  'getExplorerPreferences': DEFAULT_EXPLORER_PREFERENCES,
  'balances': () =>
    readPreviewIkaBaseMode() === 'solana' ? (BALANCES_TOLY as unknown) : (BALANCES_DEFAULT as unknown),
  'activeVaultId': () => {
    const mode = readPreviewIkaBaseMode();
    const v = VAULT_SUMMARIES.find((x) => x.baseChain === mode);
    return v?.id ?? DAVID.id;
  },
  'getNetworks': NETWORKS,
  'walletExists': true,
  'lockState': { locked: false, vaultExists: true, autoLockMinutes: 30 },
  'getActivity': ACTIVITY_DAVID,
  'listVaults': VAULT_SUMMARIES,
  'listOwnedDWalletCaps': () =>
    readPreviewIkaBaseMode() === 'solana' ? DWALLET_CAPS_TOLY : DWALLET_CAPS_DAVID,
  'dwalletAddressBook': DWALLET_ADDRESS_BOOK,
  'getDwalletDisplayNames': DWALLET_DISPLAY_NAMES,
  'getDwalletCardOrder': DWALLET_CARD_ORDER,
  'getEvmTokenBalances': EVM_TOKEN_BALANCES,
  'portfolioRailBalances': (input: unknown) => {
    const rail = (input as { rail?: string } | undefined)?.rail;
    if (rail === 'sui') return PORTFOLIO_RAIL_BALANCES_SUI;
    if (rail === 'solana') return PORTFOLIO_RAIL_BALANCES_SOLANA;
    if (rail === 'btcP2wpkh' || rail === 'btcP2tr') return PORTFOLIO_RAIL_BALANCES_BTC;
    if (rail === 'aptos') return PORTFOLIO_RAIL_BALANCES_APTOS;
    return [];
  },
  // returns null - no chroma-lab refs / pending dwallets / nft rows for the demo
  // (the previous shape `{ secp256k1: null, ed25519: null }` predates ChromaLabPage going live
  // in dev preview; the real shape has `networkIds.sui` + `sui.packageRefs` etc that the page
  // walks with non-optional chaining. null lets the page short-circuit cleanly into empty state.)
  'getChromaLabRefs': null,
  'getDwalletHomeGasMany': { byDwalletId: {} },
  'getPendingDwalletStates': [],
  'getDappPermissions': {
    'https://app.uniswap.org': {
      selectedDwalletId: DWALLET_CAPS_DAVID[0].dwalletId,
      selectedEd25519DwalletId: DWALLET_CAPS_DAVID[1].dwalletId,
    },
  },
  'getVaultNameHints': new Map(),
  'getNftsCollectibles': { items: [], cursor: null },
  'getNftKiosks': { items: [], cursor: null },

  // ika staking page - reads validators live off Sui mainnet GraphQL using the same query
  // the production background uses (see `listIkaValidatorsForSession` in
  // `src/background/ika/ika-staking.ts`). The preview has no service worker / session, so
  // we POST to the public GraphQL endpoint directly with the Ika mainnet package id from
  // `@ika.xyz/sdk`'s `getNetworkConfig('mainnet')`. Cached for 60s so the page's 5-min poll
  // and any re-renders don't hammer the endpoint.
  'ikaStakingValidators': () => fetchMainnetValidatorsCached(),
  'ikaStakingPositions': [
    {
      objectId: '0xabcd1234efabcd5678ef9012abcdef3456789012abcdef34567890abcdef1111',
      validatorId: '0x86eaa6f3b1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c83ac5',
      principalBaseUnits: '12500000000000',
      activationEpoch: 280,
    },
  ],
  // `ikaStakingEpoch` mirrors `getIkaSystemSnapshotForSession`. The production code reads
  // these fields off the Ika `SystemInner` parsed by `IkaClient.ensureInitialized()`; the
  // preview can't spin up an IkaClient without a session, and the SystemInner is hidden
  // behind a Versioned/dynamic-field wrapper that's painful to walk from raw GraphQL JSON.
  // So we keep the epoch / duration / subsidy / activeValidatorCount as a synthetic snapshot
  // anchored to the live validator count once that fetch resolves. The synthetic subsidy is
  // calibrated against inkwell's public `stakingRewards: 18511662347279` per validator.
  'ikaStakingEpoch': async () => {
    const validators = await fetchMainnetValidatorsCached().catch(() => [] as IkaValidatorRow[]);
    const activeValidatorCount = validators.filter((v) => v.status === 'Active').length || 18;
    return {
      epoch: 286,
      epochStartTimestampMs: Date.now() - 12 * 60 * 60 * 1000,
      epochDurationMs: 24 * 60 * 60 * 1000,
      protocolVersion: 3,
      totalStakeBaseUnits: String(
        validators.reduce((a, v) => a + BigInt(v.totalStakeBaseUnits || '0'), 0n),
      ),
      // inkwell's `stakingRewards` is the per-validator value; multiply by the active set to
      // recover the system-wide subsidy that the UI divides back down by `activeValidatorCount`.
      stakeSubsidyAmountPerDistributionBaseUnits: String(
        18_511_662_347_279n * BigInt(activeValidatorCount),
      ),
      activeValidatorCount,
      fetchedAtMs: Date.now(),
    };
  },

  // payments page (x402) - PaymentsSettingsSection reads `x402GetCaps`. CapsBundle shape:
  // { caps: { globalDailyCapUsd, defaultPerCounterpartyDailyCapUsd, perCounterpartyDailyCapUsd },
  //   spendToday: { globalUsd, perHostUsd } }
  'x402GetCaps': {
    caps: {
      globalDailyCapUsd: 20,
      defaultPerCounterpartyDailyCapUsd: 5,
      perCounterpartyDailyCapUsd: {},
    },
    spendToday: {
      globalUsd: 0,
      perHostUsd: {},
    },
  },
  'x402ListReceipts': [],
  'x402PrivateReceiptsEnabled': false,
  'x402ListPrivateReceipts': [],

  // agents page (mcp native host) - AgentsSettingsSection reads `mcpStatus`.
  // Real shape includes a `native: { connected, lastError }` block per access at
  // AgentsSettingsSection.tsx:103.
  'mcpStatus': {
    enabled: false,
    tokenHex: '',
    listenPort: null,
    listenHost: '127.0.0.1',
    nativeHostName: 'com.chromatika.mcp_host',
    desiredListenPort: null,
    running: false,
    hostAvailable: false,
    native: {
      connected: false,
      lastError: null,
    },
  },

  // chromalab page extras
  'getSuiExplorerOverview': null,
  'getSolanaProgramRecentOverview': null,
  'getSuiExplorerDwalletDetail': null,
  'getSolanaExplorerDwalletDetail': null,
  'getUnverifiedPresignCapSample': {
    observed: 18,
    truncated: false,
    recent: [
      {
        id: '0x9b2a73c4e8a1d5f7b62e09c3a0d4f1e8b7c5a26d49381fe04bc7d12a8e3f5901',
        dwalletId: '0xa1f3c25e80d7b6c4a92e4f08d5b7c6e1a39f80d4c2b5a87e6f1d09c3b425e8a7',
        presignId: '0x4d5e6f70a1b2c3d4e5f6071829304a5b6c7d8e9f0a1b2c3d4e5f60718293040b',
      },
      {
        id: '0x7c0f9a3b6e4d5c8a1b2f3e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b9a0f1e2d3c4b',
        dwalletId: null,
        presignId: '0x6a5b4c3d2e1f00112233445566778899aabbccddeeff00112233445566778899',
      },
      {
        id: '0x3e2d1c0b9a8f7e6d5c4b3a2918273645c5b4a392817061455f4e3d2c1b0a9988',
        dwalletId: '0xbeefcafe1234567890abcdef1234567890abcdef1234567890abcdef12345678',
        presignId: '0x112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00',
      },
    ],
    capType: '0xdd24c62739923fbf582f49ef190b4a007f981ca6eb209ca94f3a8eaf7c611317::coordinator_inner::UnverifiedPresignCap',
    suiscanCollectionUrl: 'https://suiscan.xyz/mainnet/collection/0xdd24c62739923fbf582f49ef190b4a007f981ca6eb209ca94f3a8eaf7c611317::coordinator_inner::UnverifiedPresignCap/items',
  },

  // policy vault page. The legacy `getPolicyVaultStatus` / `getPolicyVaultCaps`
  // entries below are stale (no matching tRPC procedure today) and kept only
  // to avoid no-fixture warnings if some other surface references them. The
  // panel + banner call `getPolicyVaultState` + `getPolicyAuditEntries`.
  //
  // URL params:
  //   ?baseChain=solana - show the "Policy Vault is Sui-only for now" disabled state
  //   ?package=none     - show "no built-in for this network" state (registry empty)
  //   ?wrapped=1        - seed one wrapped SECP dWallet + cached snapshot so the full
  //                       state-3 surface renders (vault id + cap gauge + actuators +
  //                       tune + PANIC + audit log + exit policy)
  //   ?wrapped=2        - additionally seed a second wrap (ED25519) so the
  //                       multi-wrap hint banner surfaces above the primary wrap
  //   ?wrapped=panic    - seed a wrapped dWallet that is currently panicked
  //   (default)         - show the built-in sui-mainnet entry, opt-in available
  'getPolicyVaultState': (() => {
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const baseChain = params?.get('baseChain') === 'solana' ? ('solana' as const) : ('sui' as const);
    if (baseChain === 'solana') {
      return { packageConfig: null, links: [], activeVaultBaseChain: baseChain };
    }
    if (params?.get('package') === 'none') {
      return { packageConfig: null, links: [], activeVaultBaseChain: baseChain };
    }
    const packageConfig = {
      packageId: '0x8cd25cd3ae7966b61eeae97d77b7e029b29b37307b533b505c6a76b63e22d727',
      setAtMs: Date.parse('2026-05-11T15:00:00Z'),
      label: 'chromatika built-in (sui mainnet, iteration deploy 2026-05-11)',
      builtin: true,
    };
    const wrappedMode = params?.get('wrapped');
    if (wrappedMode) {
      const isPanic = wrappedMode === 'panic';
      const now = Date.now();
      const secpLink = {
        vaultObjectId: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        dwalletId: '0x1111111111111111111111111111111111111111111111111111111111111111',
        primaryActuator: '0x2222222222222222222222222222222222222222222222222222222222222222',
        optInAtMs: now - 86_400_000 * 3,
        curve: 0,
        signatureAlgorithm: 0,
        baseChain: 'sui' as const,
      };
      const secpSnapshot = {
        panicked: isPanic,
        panicAtMs: isPanic ? now - 3_600_000 : 0,
        unfreezeDelayMs: 7 * 86_400_000,
        unfreezeUnlocksAtMs: isPanic ? now + 6 * 86_400_000 : 0,
        dailyCapMicros: '1000000000', // $1,000
        spentTodayMicros: '237500000', // $237.50
        coolDownMs: 60_000,
        lastSignAtMs: now - 12 * 60_000,
        actuators: [
          secpLink.primaryActuator,
          '0x3333333333333333333333333333333333333333333333333333333333333333',
        ],
        hasRescueAddress: true,
        ikaBalance: '8500000', // 0.0085 IKA
        suiBalance: '7200000', // 0.0072 SUI
        presignsRemaining: 4,
        epochDay: 19850,
        stageCapRaises: true,
        stageDelayMs: 86_400_000,
        hasPendingCap: false,
        pendingCapMicros: '0',
        pendingCapAtMs: 0,
        pendingStageOff: false,
        pendingStageOffAtMs: 0,
        unwrapRequested: false,
        unwrapAtMs: 0,
      };
      const links: Array<{ link: typeof secpLink; snapshot: typeof secpSnapshot }> = [
        { link: secpLink, snapshot: secpSnapshot },
      ];
      if (wrappedMode === '2') {
        const edLink = {
          ...secpLink,
          vaultObjectId: '0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
          dwalletId: '0x4444444444444444444444444444444444444444444444444444444444444444',
          curve: 2,
          signatureAlgorithm: 3,
          optInAtMs: now - 86_400_000,
        };
        const edSnap = {
          ...secpSnapshot,
          dailyCapMicros: '500000000',
          spentTodayMicros: '12000000',
        };
        links.push({ link: edLink, snapshot: edSnap });
      }
      return { packageConfig, links, activeVaultBaseChain: baseChain };
    }
    return {
      packageConfig,
      // With per-(vault, dwallet) wraps, the panel scrolls through `links`. Preview
      // defaults to an empty array so the "configured, not opted in" UI renders;
      // ?wrapped=1 / ?wrapped=2 / ?wrapped=panic seed wraps to demo the post-opt-in
      // surface (PANIC button + cap gauge + tune drawer + audit log + exit policy).
      links: [],
      activeVaultBaseChain: baseChain,
    };
  })(),
  'getPolicyAuditEntries': (() => {
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    if (!params?.get('wrapped')) {
      return { entries: [] };
    }
    const now = Date.now();
    return {
      entries: [
        {
          timestampMs: now - 86_400_000 * 3,
          vaultId: 'preview-vault',
          dwalletId: '0x1111111111111111111111111111111111111111111111111111111111111111',
          kind: 'opt-in' as const,
          digest: 'preview-digest-opt-in',
        },
        {
          timestampMs: now - 86_400_000 * 2,
          vaultId: 'preview-vault',
          dwalletId: '0x1111111111111111111111111111111111111111111111111111111111111111',
          kind: 'add-actuator' as const,
          detail: '0x3333333333333333333333333333333333333333333333333333333333333333',
          digest: 'preview-digest-add-actuator',
        },
        {
          timestampMs: now - 86_400_000,
          vaultId: 'preview-vault',
          dwalletId: '0x1111111111111111111111111111111111111111111111111111111111111111',
          kind: 'sign-cap-applied' as const,
          next: '47500000',
          digest: 'preview-digest-sign-1',
        },
        {
          timestampMs: now - 12 * 60_000,
          vaultId: 'preview-vault',
          dwalletId: '0x1111111111111111111111111111111111111111111111111111111111111111',
          kind: 'sign-cap-applied' as const,
          next: '52000000',
          digest: 'preview-digest-sign-2',
        },
      ],
    };
  })(),
  'getPolicyVaultStatus': { active: false, vaultObjectId: null },
  'getPolicyVaultCaps': null,
  'getPolicyVaultAuditLog': [],
  'getPolicyVaultActuators': [],

  // "don't ask me again" global flag for the post-creation Policy Vault prompt.
  // The preview always returns `false` so the modal mounts fresh on every reload.
  'getPolicyVaultPromptState': { globallyDismissed: false },
  // Successful one-click wrap stub - returns a fake PolicyVaultLink shape and digest.
  'optInToPolicyVault': {
    link: {
      vaultObjectId: '0xpreview000000000000000000000000000000000000000000000000000preview',
      dwalletId: '0xpreview000000000000000000000000000000000000000000000000000dwallet',
      primaryActuator: '0xpreview',
      optInAtMs: Date.now(),
      curve: 0,
      signatureAlgorithm: 0,
      baseChain: 'sui' as const,
    },
    digest: 'preview-digest',
  },
  // No-op stub - preview just needs the mutation to resolve.
  'setPolicyVaultPromptGloballyDismissed': { ok: true as const },

  // Extended dwallet-create-prompt-state shape (now returns perVault + global).
  'getDWalletCreatePromptState': { dismissed: false, perVault: false, global: false },
  'setDwalletCreatePromptGloballyDismissed': { ok: true as const },
};

let WARNED = new Set<string>();

export function resolveFixture(procedure: string, input: unknown): unknown {
  const entry = REGISTRY[procedure];
  if (entry === undefined) {
    if (!WARNED.has(procedure)) {
      WARNED.add(procedure);
      // surface in console so we know which procedures the rendered screens hit -
      // tells us what fixtures to fill in next
      console.info(`[chromatika preview] no fixture for trpc.${procedure} - resolving null`);
    }
    return null;
  }
  if (typeof entry === 'function') return (entry as FixtureFactory)(input);
  return entry;
}

export function registerFixture(procedure: string, value: FixtureEntry): void {
  REGISTRY[procedure] = value;
}

// Re-export for convenience so registry callers don't have to import personas separately.
export { DAVID };
