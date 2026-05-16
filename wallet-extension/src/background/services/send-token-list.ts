/**
 * cross-chain token-list aggregator for the Send tab.
 *
 * inputs:
 *   - scope: which addresses to enumerate (`dwallet` / `vault` / `everything`).
 *   - selectedDwalletId: only used by the `dwallet` scope.
 *   - networkFilter: `'all'` or a chain-family filter applied to rows on the way out.
 *
 * outputs:
 *   - rows: cross-chain coin rows with iconUrl, balance + USD where available.
 *   - partial: at least one probe failed (cache still gets written; UI shows soft warning).
 *   - policyLinksByOwner: keyed by `ownerAddress` so the Confirm step can join + render the
 *     PolicyVault gauge inline.
 *
 * cache:
 *   - per-vault + per-scope row at `VAULT_SCOPED_KEYS.sendTokenList(vaultId, scope, selectionKey)`.
 *   - 5-min TTL, SWR. cleared on switchVault / addVault / removeVault via the existing
 *     `clearVaultScopedStorage` helper plus a dedicated `sendTokenListPrefix` sweep.
 */

import { getSession } from '@/background/session';
import { getActiveNetworks } from '@/background/network/active-network';
import { getCustomNetworks } from '@/background/network/custom-networks';
import {
  BUILTIN_APTOS,
  BUILTIN_BITCOIN,
  mergeEvmNetworksWithCustom,
  type EvmNetwork,
} from '@/config/networks';
import { listAddressesForVaultFromMeta } from '@/background/services/vault-total-fetchers';
import { fetchEvmTokenBalances } from '@/background/chains/evm-tokens';
import { fetchPortfolioRailNativeRows } from '@/background/portfolio-rail-balances';
import { listSolanaSplBalances } from '@/background/chains/solana-list-spl';
import { getPrice } from '@/background/services/price';
import { listPolicyVaultLinks } from '@/background/policy-vault/policy-vault-storage';
import { readPolicyVaultSnapshot } from '@/background/policy-vault/policy-vault-read';
import type {
  SendPolicyLinkSnapshot,
  SendTokenChain,
  SendTokenListResult,
  SendTokenNetworkFilter,
  SendTokenRow,
  SendTokenScope,
} from './send-token-types';

const SOLANA_KNOWN_SPL_MINTS: Record<string, { symbol: string; decimals: number }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: 'JUP', decimals: 6 },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: 'BONK', decimals: 5 },
};

const NATIVE_SUI_COIN_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

// ---------------------------------------------------------------------------
// owner sources
// ---------------------------------------------------------------------------

type OwnerSourceKind = 'dwallet' | 'vault-keypair';

type OwnerSource = {
  kind: OwnerSourceKind;
  /** human label rendered in the row owner column. */
  label: string;
  /** EVM hex / Sui 0x / Solana base58 / BTC bech32 / Aptos hex. exactly one address per chain. */
  addresses: {
    evm?: string;
    sui?: string;
    solana?: string;
    btcP2wpkh?: string;
    btcP2tr?: string;
    aptos?: string;
  };
  /** for dwallet kind only. */
  dwalletId?: string;
  /** curves present on this source (used to filter the network selector). */
  curves: Array<'SECP256K1' | 'ED25519'>;
};

function vaultKeypairSources(): OwnerSource[] {
  const s = getSession();
  if (!s) return [];
  const out: OwnerSource[] = [];

  // Sui-base vault keypair (suiKeypair derives a Sui address; addresses on other chains would
  // require a separate keypair so we don't surface them here).
  try {
    const suiAddr = s.suiKeypair.getPublicKey().toSuiAddress();
    if (suiAddr) {
      out.push({
        kind: 'vault-keypair',
        label: 'Vault fee-payer (Sui)',
        addresses: { sui: suiAddr },
        curves: ['ED25519'],
      });
    }
  } catch {
    /* no sui keypair on solana-base vault */
  }

  // Solana-base vault: hardware/MWA/WC address is the user-facing vault address.
  const hardwareSolAddress =
    s.solanaLedgerFee?.feePayerPubkeyB58 ?? s.solanaMwaAccount?.address ?? s.solanaWcAccount?.address;
  if (hardwareSolAddress) {
    out.push({
      kind: 'vault-keypair',
      label: 'Vault (hardware)',
      addresses: { solana: hardwareSolAddress },
      curves: ['ED25519'],
    });
  }
  // Local gRPC fee-payer keypair (always regenerated per install on hardware vaults). On HD
  // vaults this is the same keypair as the hardware path is absent. always include - the user
  // explicitly asked for both addresses when distinct.
  if (s.solanaFeePayer) {
    const grpcAddr = s.solanaFeePayer.publicKey.toBase58();
    const dup = hardwareSolAddress && hardwareSolAddress.toLowerCase() === grpcAddr.toLowerCase();
    if (!dup) {
      out.push({
        kind: 'vault-keypair',
        label: hardwareSolAddress ? 'Vault fee-payer (gRPC)' : 'Vault fee-payer (Solana)',
        addresses: { solana: grpcAddr },
        curves: ['ED25519'],
      });
    }
  }

  return out;
}

async function dwalletSources(vaultId: string): Promise<OwnerSource[]> {
  const dwallets = await listAddressesForVaultFromMeta(vaultId);
  const sources: OwnerSource[] = [];
  // We label by occurrence order ("dWallet 1", "dWallet 2", ...) since the existing
  // user-friendly label helpers want a full ListedDwalletCap context we don't have here.
  // The UI can re-label via the existing dwallet display names map if it wants prettier copy.
  dwallets.forEach((d, i) => {
    const curves: Array<'SECP256K1' | 'ED25519'> = [];
    if (d.addresses.evm || d.addresses.btcP2wpkh || d.addresses.btcP2tr) curves.push('SECP256K1');
    if (d.addresses.sui || d.addresses.solana || d.addresses.aptos) curves.push('ED25519');
    if (curves.length === 0) return;
    const dwalletTail = d.dwalletId.slice(-6);
    sources.push({
      kind: 'dwallet',
      label: `dWallet ${i + 1} (${dwalletTail})`,
      addresses: {
        evm: d.addresses.evm,
        sui: d.addresses.sui,
        solana: d.addresses.solana,
        btcP2wpkh: d.addresses.btcP2wpkh,
        btcP2tr: d.addresses.btcP2tr,
        aptos: d.addresses.aptos,
      },
      dwalletId: d.dwalletId,
      curves,
    });
  });
  return sources;
}

async function resolveOwnerSources(
  scope: SendTokenScope,
  vaultId: string,
  selectedDwalletId: string | undefined,
): Promise<OwnerSource[]> {
  if (scope === 'vault') return vaultKeypairSources();
  const dws = await dwalletSources(vaultId);
  if (scope === 'dwallet') {
    if (!selectedDwalletId) {
      // no selection => default to the first dWallet, matching the dWallet tab's `effectiveId` fallback.
      return dws.slice(0, 1);
    }
    return dws.filter((d) => d.dwalletId === selectedDwalletId);
  }
  // 'everything'
  return [...vaultKeypairSources(), ...dws];
}

// ---------------------------------------------------------------------------
// row helpers
// ---------------------------------------------------------------------------

function addressHash8(addr: string): string {
  // small deterministic suffix for the row key; we don't need cryptographic quality here.
  let h = 0;
  for (let i = 0; i < addr.length; i++) {
    h = ((h << 5) - h + addr.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}

function makeRowKey(chain: SendTokenChain, ownerAddress: string, idSuffix: string): string {
  return `${chain}:${addressHash8(ownerAddress)}:${idSuffix}`;
}

function parseBalanceToFloat(raw: string, decimals: number): number {
  if (!raw || raw === '0') return 0;
  try {
    const bi = BigInt(raw);
    const denom = BigInt(10) ** BigInt(decimals);
    const whole = bi / denom;
    const frac = bi % denom;
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, 8);
    return Number(`${whole.toString()}.${fracStr}`);
  } catch {
    return Number.parseFloat(raw);
  }
}

// ---------------------------------------------------------------------------
// per-source probes
// ---------------------------------------------------------------------------

async function probeEvmTokensForSource(
  source: OwnerSource,
  chains: EvmNetwork[],
  acc: SendTokenRow[],
  failed: { count: number },
): Promise<void> {
  const addr = source.addresses.evm;
  if (!addr) return;
  for (const chain of chains) {
    try {
      const r = await fetchEvmTokenBalances(addr, chain.chainId);
      for (const t of r) {
        const decimals = t.decimals;
        const balanceFloat = Number.parseFloat(t.balanceFormatted) || 0;
        if (balanceFloat <= 0) continue;
        const balanceRaw = t.balanceRaw;
        const idSuffix = (t.contractAddress ?? 'native').toLowerCase();
        const pricePerTokenUsd =
          t.usdValue != null && balanceFloat > 0 ? t.usdValue / balanceFloat : null;
        acc.push({
          key: makeRowKey('evm', addr, `${chain.chainId}:${idSuffix}`),
          ownerAddress: addr,
          ownerLabel: source.label,
          ownerDwalletId: source.dwalletId,
          chain: 'evm',
          networkLabel: chain.name,
          chainId: chain.chainId,
          symbol: t.symbol,
          name: t.name,
          decimals,
          contractAddress: t.contractAddress ?? undefined,
          iconUrl: t.iconUrl,
          balanceRaw,
          balanceFormatted: t.balanceFormatted,
          pricePerTokenUsd,
          totalUsdValue: t.usdValue ?? null,
        });
      }
    } catch {
      failed.count++;
    }
  }
}

async function probeSuiForSource(
  source: OwnerSource,
  networkLabel: string,
  acc: SendTokenRow[],
  failed: { count: number },
): Promise<void> {
  const addr = source.addresses.sui;
  if (!addr) return;
  try {
    const rows = await fetchPortfolioRailNativeRows('sui', addr);
    for (const r of rows) {
      const decimals = 9;
      const balanceFloat = Number.parseFloat(r.balanceFormatted) || 0;
      if (balanceFloat <= 0) continue;
      const pricePerTokenUsd =
        r.usdValue != null && balanceFloat > 0 ? r.usdValue / balanceFloat : null;
      const coinType = r.symbol === 'SUI' ? NATIVE_SUI_COIN_TYPE : undefined;
      const idSuffix = r.symbol.toLowerCase();
      acc.push({
        key: makeRowKey('sui', addr, idSuffix),
        ownerAddress: addr,
        ownerLabel: source.label,
        ownerDwalletId: source.dwalletId,
        chain: 'sui',
        networkLabel,
        symbol: r.symbol,
        name: r.name,
        decimals,
        coinType,
        balanceRaw: r.balanceRaw,
        balanceFormatted: r.balanceFormatted,
        pricePerTokenUsd,
        totalUsdValue: r.usdValue,
      });
    }
  } catch {
    failed.count++;
  }
}

async function probeSolanaForSource(
  source: OwnerSource,
  networkLabel: string,
  acc: SendTokenRow[],
  failed: { count: number },
): Promise<void> {
  const addr = source.addresses.solana;
  if (!addr) return;
  // native SOL via the portfolio rail.
  try {
    const rows = await fetchPortfolioRailNativeRows('solana', addr);
    for (const r of rows) {
      const balanceFloat = Number.parseFloat(r.balanceFormatted) || 0;
      if (balanceFloat <= 0) continue;
      const pricePerTokenUsd =
        r.usdValue != null && balanceFloat > 0 ? r.usdValue / balanceFloat : null;
      acc.push({
        key: makeRowKey('solana', addr, 'native'),
        ownerAddress: addr,
        ownerLabel: source.label,
        ownerDwalletId: source.dwalletId,
        chain: 'solana',
        networkLabel,
        symbol: r.symbol,
        name: r.name,
        decimals: 9,
        balanceRaw: r.balanceRaw,
        balanceFormatted: r.balanceFormatted,
        pricePerTokenUsd,
        totalUsdValue: r.usdValue,
      });
    }
  } catch {
    failed.count++;
  }
  // SPL via the dwallet-tier connection.
  try {
    const s = getSession();
    if (!s) return;
    const splRows = await listSolanaSplBalances(addr, s.dwalletSolanaConnection);
    const knownMintSymbols = SOLANA_KNOWN_SPL_MINTS;
    for (const r of splRows) {
      const known = knownMintSymbols[r.mint];
      const symbol = known?.symbol ?? r.mint.slice(0, 4).toUpperCase();
      const name = known?.symbol ?? `SPL (${r.mint.slice(0, 6)}...)`;
      const balanceFloat = parseBalanceToFloat(r.balanceRaw, r.decimals);
      if (balanceFloat <= 0) continue;
      let pricePerTokenUsd: number | null = null;
      let totalUsdValue: number | null = null;
      if (known) {
        try {
          const p = await getPrice(known.symbol);
          if (p > 0) {
            pricePerTokenUsd = p;
            totalUsdValue = p * balanceFloat;
          }
        } catch {
          /* leave null */
        }
      }
      acc.push({
        key: makeRowKey('solana', addr, r.mint),
        ownerAddress: addr,
        ownerLabel: source.label,
        ownerDwalletId: source.dwalletId,
        chain: 'solana',
        networkLabel,
        symbol,
        name,
        decimals: r.decimals,
        mint: r.mint,
        balanceRaw: r.balanceRaw,
        balanceFormatted: r.balance,
        pricePerTokenUsd,
        totalUsdValue,
      });
    }
  } catch {
    failed.count++;
  }
}

async function probeBtcForSource(
  source: OwnerSource,
  networkLabel: string,
  acc: SendTokenRow[],
  failed: { count: number },
): Promise<void> {
  const variants: Array<['btcP2wpkh' | 'btcP2tr', string | undefined]> = [
    ['btcP2wpkh', source.addresses.btcP2wpkh],
    ['btcP2tr', source.addresses.btcP2tr],
  ];
  for (const [rail, addr] of variants) {
    if (!addr) continue;
    try {
      const rows = await fetchPortfolioRailNativeRows(rail, addr);
      for (const r of rows) {
        const balanceFloat = Number.parseFloat(r.balanceFormatted) || 0;
        if (balanceFloat <= 0) continue;
        const pricePerTokenUsd =
          r.usdValue != null && balanceFloat > 0 ? r.usdValue / balanceFloat : null;
        const variant = rail === 'btcP2wpkh' ? 'segwit' : 'taproot';
        acc.push({
          key: makeRowKey('btc', addr, variant),
          ownerAddress: addr,
          ownerLabel: `${source.label} - ${variant}`,
          ownerDwalletId: source.dwalletId,
          chain: 'btc',
          networkLabel: `${networkLabel} (${variant})`,
          symbol: r.symbol,
          name: r.name,
          decimals: 8,
          balanceRaw: r.balanceRaw,
          balanceFormatted: r.balanceFormatted,
          pricePerTokenUsd,
          totalUsdValue: r.usdValue,
        });
      }
    } catch {
      failed.count++;
    }
  }
}

async function probeAptosForSource(
  source: OwnerSource,
  networkLabel: string,
  acc: SendTokenRow[],
  failed: { count: number },
): Promise<void> {
  const addr = source.addresses.aptos;
  if (!addr) return;
  try {
    const rows = await fetchPortfolioRailNativeRows('aptos', addr);
    for (const r of rows) {
      const balanceFloat = Number.parseFloat(r.balanceFormatted) || 0;
      if (balanceFloat <= 0) continue;
      const pricePerTokenUsd =
        r.usdValue != null && balanceFloat > 0 ? r.usdValue / balanceFloat : null;
      acc.push({
        key: makeRowKey('aptos', addr, 'native'),
        ownerAddress: addr,
        ownerLabel: source.label,
        ownerDwalletId: source.dwalletId,
        chain: 'aptos',
        networkLabel,
        symbol: r.symbol,
        name: r.name,
        decimals: 8,
        balanceRaw: r.balanceRaw,
        balanceFormatted: r.balanceFormatted,
        pricePerTokenUsd,
        totalUsdValue: r.usdValue,
      });
    }
  } catch {
    failed.count++;
  }
}

// ---------------------------------------------------------------------------
// policy join
// ---------------------------------------------------------------------------

async function loadPolicyLinkSnapshots(
  sources: OwnerSource[],
): Promise<Record<string, SendPolicyLinkSnapshot>> {
  const s = getSession();
  if (!s) return {};
  // Policy Vault is Sui-base only today; on Solana-base sessions, short-circuit.
  if (s.activeVaultBaseChain !== 'sui') return {};
  // map dwalletId -> sui address from the source list, so we can join after reading links.
  const dwalletToSuiAddr = new Map<string, string>();
  for (const src of sources) {
    if (src.kind === 'dwallet' && src.dwalletId && src.addresses.sui) {
      dwalletToSuiAddr.set(src.dwalletId, src.addresses.sui);
    }
    // EVM-curve dwallets can also be policy-wrapped: the policy gate sits on the Sui ika cap,
    // not the curve. include EVM-address entries too so the Confirm step can clamp ETH sends.
    if (src.kind === 'dwallet' && src.dwalletId && src.addresses.evm) {
      dwalletToSuiAddr.set(`${src.dwalletId}:evm`, src.addresses.evm);
    }
  }

  const links = await listPolicyVaultLinks(s.activeVaultId);
  const out: Record<string, SendPolicyLinkSnapshot> = {};
  for (const link of links) {
    let snapshot;
    try {
      snapshot = await readPolicyVaultSnapshot(s.suiClient, link.vaultObjectId);
    } catch {
      continue;
    }
    if (!snapshot) continue;
    const remaining = (() => {
      const cap = BigInt(snapshot.dailyCapMicros);
      const spent = BigInt(snapshot.spentTodayMicros);
      return cap > spent ? (cap - spent).toString() : '0';
    })();
    const snapshotForOwner: SendPolicyLinkSnapshot = {
      dwalletId: link.dwalletId,
      vaultObjectId: link.vaultObjectId,
      dailyCapMicros: snapshot.dailyCapMicros,
      spentTodayMicros: snapshot.spentTodayMicros,
      remainingMicros: remaining,
      panicked: snapshot.panicked,
      coolDownMs: snapshot.coolDownMs,
      unfreezeUnlocksAtMs: snapshot.unfreezeUnlocksAtMs,
    };
    // index by every address that maps to this dwalletId.
    for (const src of sources) {
      if (src.kind !== 'dwallet' || src.dwalletId !== link.dwalletId) continue;
      for (const key of Object.keys(src.addresses) as Array<keyof OwnerSource['addresses']>) {
        const a = src.addresses[key];
        if (a) out[a] = snapshotForOwner;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// network resolution helpers
// ---------------------------------------------------------------------------

async function resolveEvmChains(): Promise<EvmNetwork[]> {
  const { evm: custom } = await getCustomNetworks();
  const merged = mergeEvmNetworksWithCustom(custom);
  // surface mainnets first, then customs (which the user added intentionally), then testnets.
  // testnets identified by chainId >= 10000 OR name contains 'goerli'/'sepolia'/'fuji'/'mumbai'.
  function isTestnet(n: EvmNetwork): boolean {
    if (n.chainId >= 10_000 && n.isCustom === false) return true;
    const lower = n.name.toLowerCase();
    return ['sepolia', 'goerli', 'fuji', 'mumbai', 'amoy', 'testnet'].some((t) => lower.includes(t));
  }
  return merged.filter((n) => !isTestnet(n));
}

// ---------------------------------------------------------------------------
// public api: compute (uncached) + cache wrappers
// ---------------------------------------------------------------------------

export async function computeSendTokenList(
  scope: SendTokenScope,
  vaultId: string,
  options: {
    selectedDwalletId?: string;
    networkFilter?: SendTokenNetworkFilter;
  } = {},
): Promise<SendTokenListResult & { allowedCurves: Array<'SECP256K1' | 'ED25519'> }> {
  const sources = await resolveOwnerSources(scope, vaultId, options.selectedDwalletId);
  if (sources.length === 0) {
    return { rows: [], partial: false, policyLinksByOwner: {}, allowedCurves: [] };
  }
  const allowedCurvesSet = new Set<'SECP256K1' | 'ED25519'>();
  for (const src of sources) for (const c of src.curves) allowedCurvesSet.add(c);

  const networks = await getActiveNetworks();
  const evmChains = await resolveEvmChains();
  const suiNetworkLabel = networks.suiNetworkId;
  const solanaNetworkLabel = networks.solNetworkId;
  const btcNetworkLabel =
    BUILTIN_BITCOIN.find((n) => n.id === networks.btcNetworkId)?.name ?? 'Bitcoin';
  const aptosNetworkLabel =
    BUILTIN_APTOS.find((n) => n.id === networks.aptNetworkId)?.name ?? 'Aptos';

  const rows: SendTokenRow[] = [];
  const failed = { count: 0 };

  for (const source of sources) {
    await Promise.all([
      probeEvmTokensForSource(source, evmChains, rows, failed),
      probeSuiForSource(source, suiNetworkLabel, rows, failed),
      probeSolanaForSource(source, solanaNetworkLabel, rows, failed),
      probeBtcForSource(source, btcNetworkLabel, rows, failed),
      probeAptosForSource(source, aptosNetworkLabel, rows, failed),
    ]);
  }

  // sort by total USD value DESC; ties fall back to key ASC for stability.
  rows.sort((a, b) => {
    const av = a.totalUsdValue ?? -1;
    const bv = b.totalUsdValue ?? -1;
    if (bv !== av) return bv - av;
    return a.key.localeCompare(b.key);
  });

  // apply network filter on the way out (computing is cheap, lets the same cache satisfy many filters)
  const filter = options.networkFilter ?? 'all';
  const filtered = filter === 'all' ? rows : rows.filter((r) => r.chain === filter);

  const policyLinksByOwner = await loadPolicyLinkSnapshots(sources);

  return {
    rows: filtered,
    partial: failed.count > 0,
    policyLinksByOwner,
    allowedCurves: [...allowedCurvesSet],
  };
}

// ---------------------------------------------------------------------------
// cache (session, SWR, 5-min TTL)
// ---------------------------------------------------------------------------

import { VAULT_SCOPED_KEYS } from '@/background/storage';

type CachedSendTokenList = SendTokenListResult & {
  allowedCurves: Array<'SECP256K1' | 'ED25519'>;
  scope: SendTokenScope;
  selectionKey: string;
  fetchedAtMs: number;
};

const SEND_TOKEN_LIST_TTL_MS = 5 * 60 * 1000;

function selectionKeyFor(scope: SendTokenScope, selectedDwalletId?: string): string {
  if (scope === 'dwallet' && selectedDwalletId) return selectedDwalletId.slice(-12);
  return '_';
}

export async function readCachedSendTokenList(
  vaultId: string,
  scope: SendTokenScope,
  selectedDwalletId: string | undefined,
): Promise<CachedSendTokenList | null> {
  const key = VAULT_SCOPED_KEYS.sendTokenList(vaultId, scope, selectionKeyFor(scope, selectedDwalletId));
  return new Promise((resolve) => {
    chrome.storage.session.get([key], (r) => {
      const raw = r[key] as CachedSendTokenList | undefined;
      if (!raw) {
        resolve(null);
        return;
      }
      resolve(raw);
    });
  });
}

export async function writeCachedSendTokenList(
  vaultId: string,
  scope: SendTokenScope,
  selectedDwalletId: string | undefined,
  result: SendTokenListResult & { allowedCurves: Array<'SECP256K1' | 'ED25519'> },
): Promise<void> {
  const key = VAULT_SCOPED_KEYS.sendTokenList(vaultId, scope, selectionKeyFor(scope, selectedDwalletId));
  const cached: CachedSendTokenList = {
    ...result,
    scope,
    selectionKey: selectionKeyFor(scope, selectedDwalletId),
    fetchedAtMs: Date.now(),
  };
  return new Promise((resolve, reject) => {
    chrome.storage.session.set({ [key]: cached }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export function isStaleSendTokenListCache(c: CachedSendTokenList, nowMs: number): boolean {
  return nowMs - c.fetchedAtMs > SEND_TOKEN_LIST_TTL_MS;
}

export async function getOrComputeSendTokenList(
  scope: SendTokenScope,
  vaultId: string,
  options: { selectedDwalletId?: string; networkFilter?: SendTokenNetworkFilter } = {},
): Promise<SendTokenListResult & { allowedCurves: Array<'SECP256K1' | 'ED25519'> }> {
  const cached = await readCachedSendTokenList(vaultId, scope, options.selectedDwalletId);
  const now = Date.now();
  if (cached && !isStaleSendTokenListCache(cached, now)) {
    // apply network filter at read time so the cache is shared across filter changes.
    const filter = options.networkFilter ?? 'all';
    const rows = filter === 'all' ? cached.rows : cached.rows.filter((r) => r.chain === filter);
    return {
      rows,
      partial: cached.partial,
      policyLinksByOwner: cached.policyLinksByOwner,
      allowedCurves: cached.allowedCurves,
    };
  }
  const fresh = await computeSendTokenList(scope, vaultId, { selectedDwalletId: options.selectedDwalletId });
  await writeCachedSendTokenList(vaultId, scope, options.selectedDwalletId, fresh);
  const filter = options.networkFilter ?? 'all';
  const rows = filter === 'all' ? fresh.rows : fresh.rows.filter((r) => r.chain === filter);
  return { ...fresh, rows };
}

export async function clearSendTokenListCacheForVault(vaultId: string): Promise<void> {
  const prefix = VAULT_SCOPED_KEYS.sendTokenListPrefix(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.session.get(null, (all) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
      if (keys.length === 0) {
        resolve();
        return;
      }
      chrome.storage.session.remove(keys, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  });
}

