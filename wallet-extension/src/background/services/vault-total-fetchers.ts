// vault-total-fetchers.ts
//
// real per-chain balance probes for the vault total aggregator.
// each probe is wrapped in try/catch and returns { ok: false, reason } on any throw,
// so the orchestrator never sees an unhandled rejection.
//
// network settings come from two chrome.storage reads per vault:
//   - getDwalletNetworkSettings(vaultId) -> { evmChainId, suiNetworkId, aptNetworkId, btcNetworkId, solana }
//   - getCustomNetworks() -> { evm: EvmNetwork[] } for user-overridden EVM RPC rows
//
// dwallet meta is loaded from loadDwalletMeta(vaultId) -> Partial<Record<CurveKey, DWalletMeta>>.
// the relevant field for address derivation is dkgUserPublicOutputB64 (set after DKG, cleared after
// accept-share). when it's absent but dwalletId is present, we attempt chainAddressesForDwalletId
// which hits the chain (requires an active session with ikaClient).

import { JsonRpcProvider, Network, formatEther } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { getDwalletNetworkSettings, resolveSolanaRpcUrl } from '@/background/network/tier-network-settings';
import { loadDwalletMeta } from '@/background/storage-meta';
import { getPrice } from '@/background/services/price';
import {
  deriveChainAddressesFromActivePublicOutput,
  chainAddressesForDwalletId,
  type DwalletCapChainAddresses,
} from '@/background/chains/dwallet-derived-addresses';
import {
  BUILTIN_APTOS,
  BUILTIN_BITCOIN,
  mergeEvmNetworksWithCustom,
  type EvmNetwork,
} from '@/config/networks';
import {
  graphqlUrlForNetwork,
  registrySuiIdToSuiNetworkId,
  type SuiNetworkId,
} from '@/config/sui';
import { getCustomNetworks } from '@/background/network/custom-networks';
import { getDeSoNodeUrl } from '@/background/chains/deso/deso-node-client';
import type { ChainBalanceProbe, VaultDwalletAddresses } from '@/background/services/vault-total-value';
import type { NetworkTier } from '@/background/services/vault-total-cache';

/**
 * resolved set of endpoints used by every chain probe + the tier each resolved chain
 * sits on (mainnet vs testnet/devnet).
 *
 * shared shape between the per-vault path (where each field is resolved from the vault's
 * stored network preference) and the leaderboard path (where the active vault's preference
 * is the default for ALL probes regardless of which dwallet we're aggregating). lifted to a
 * dedicated type so `probeAllChainsForAddresses` is a pure function of `(addresses, bundle)`
 * and can be reused from outside the vault context.
 *
 * tiers are stamped onto each `ChainBalanceProbe` so the aggregator can split the headline
 * total: testnet balances priced against the mainnet oracle don't get swept into the
 * "real money" number.
 */
export type ChainProbeNetworkBundle = {
  suiNetwork: SuiNetworkId;
  suiGraphqlUrl: string;
  suiTier: NetworkTier;
  solRpcUrl: string | null;
  solTier: NetworkTier;
  btcEsplora: string | null;
  btcTier: NetworkTier;
  aptFullnode: string | null;
  aptTier: NetworkTier;
  desoNodeUrl: string | null;
  /** evm rows tagged per-row since user-added custom rows can be either tier. */
  evmChains: Array<{ net: EvmNetwork; tier: NetworkTier }>;
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toMicrosUsd(amount: number, priceUsd: number): bigint {
  const product = amount * priceUsd * 1_000_000;
  if (!Number.isFinite(product) || product < 0) return 0n;
  const max = (1n << 63n) - 1n;
  if (product > Number(max)) return max;
  return BigInt(Math.floor(product));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function coinTypeToSymbol(coinType: string): string | null {
  if (coinType === '0x2::sui::SUI') return 'sui';
  if (coinType.endsWith('::ika::IKA')) return 'ika';
  return null;
}

function coinTypeToDecimals(_coinType: string): number {
  // sui and ika both use 9 decimals.
  return 9;
}

// minimal mint-to-symbol map for the SPL probe. covers ~80% of typical user value
// (USDC, USDT, plus a couple top SPLs). unknown mints are silently skipped
// rather than priced as 0 - same policy as coinTypeToSymbol for unknown Sui coins.
//
// to extend: add a row here. mainnet mint addresses only; devnet mints don't have
// real prices so they're not worth listing.
const SOLANA_KNOWN_SPL_MINTS: Record<string, { symbol: string; decimals: number }> = {
  // USDC mainnet
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'usdc', decimals: 6 },
  // USDT mainnet
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'usdt', decimals: 6 },
  // JUP
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': { symbol: 'jup', decimals: 6 },
  // BONK
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { symbol: 'bonk', decimals: 5 },
};

// ---------------------------------------------------------------------------
// address listing
// ---------------------------------------------------------------------------

/**
 * build VaultDwalletAddresses[] from the per-vault dwallet meta overlay.
 *
 * two derivation paths per curve:
 *   1. dkgUserPublicOutputB64 present (post-DKG, pre-accept): derive addresses locally from the
 *      public output bytes. this avoids a network round-trip and works while the wallet is locked.
 *   2. dkgUserPublicOutputB64 absent but dwalletId present (post-accept-share): call
 *      chainAddressesForDwalletId which fetches the dWallet object from the ika chain. this
 *      requires an active session (getSession() must be non-null with a live ikaClient).
 *      on any failure we skip the curve gracefully.
 *
 * for Solana-base dwallets the dwalletPublicKeyB64 holds the raw 32-byte ed25519 key which
 * deriveChainAddressesFromActivePublicOutput already handles (length === 32 fast path).
 */
export async function listAddressesForVaultFromMeta(
  vaultId: string,
): Promise<VaultDwalletAddresses[]> {
  const meta = await loadDwalletMeta(vaultId);
  const out: VaultDwalletAddresses[] = [];

  for (const curveKey of ['SECP256K1', 'ED25519'] as const) {
    const cm = meta[curveKey];
    if (!cm?.dwalletId) continue;

    let addresses: DwalletCapChainAddresses = {};

    if (cm.dkgUserPublicOutputB64) {
      // path 1: derive locally from stored public output bytes.
      try {
        const publicOutput = Uint8Array.from(atob(cm.dkgUserPublicOutputB64), (c) => c.charCodeAt(0));
        addresses = await deriveChainAddressesFromActivePublicOutput(curveKey, publicOutput);
      } catch {
        continue;
      }
    } else if (cm.dwalletPublicKeyB64) {
      // Solana-base path: raw 32-byte public key stored separately post-DKG.
      try {
        const publicOutput = Uint8Array.from(atob(cm.dwalletPublicKeyB64), (c) => c.charCodeAt(0));
        addresses = await deriveChainAddressesFromActivePublicOutput(curveKey, publicOutput);
      } catch {
        continue;
      }
    } else {
      // path 2: fetch from chain (requires active session).
      try {
        const pack = await chainAddressesForDwalletId(cm.dwalletId);
        addresses = pack.addresses;
      } catch {
        continue;
      }
    }

    if (Object.keys(addresses).length === 0) continue;
    out.push({ dwalletId: cm.dwalletId, addresses });
  }

  return out;
}

// ---------------------------------------------------------------------------
// per-chain probes
// ---------------------------------------------------------------------------

/** per-chain cooldown after a probe failure - avoids hammering dead RPCs every cycle. */
const _evmProbeFailedUntil = new Map<string, number>();
const EVM_PROBE_FAIL_COOLDOWN_MS = 10 * 60_000; // 10 min backoff on failure
const EVM_PROBE_TIMEOUT_MS = 15_000;

async function probeEvm(
  addr: string,
  rpcUrl: string,
  chainKey: string,
  nativeSymbol: string,
  chainId: number,
  tier: NetworkTier,
): Promise<ChainBalanceProbe> {
  const cooldownEnd = _evmProbeFailedUntil.get(chainKey);
  if (cooldownEnd && Date.now() < cooldownEnd) {
    return { chainKey, tier, usdMicros: 0n, ok: false, reason: 'cooldown-after-failure' };
  }
  try {
    // staticNetwork with explicit chain id kills the eth_chainId preflight round-trip
    // and prevents ethers from retrying network detection on auth failures.
    const provider = new JsonRpcProvider(rpcUrl, Network.from(chainId), { staticNetwork: true });
    const wei = await Promise.race([
      provider.getBalance(addr),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('evm probe timeout')), EVM_PROBE_TIMEOUT_MS),
      ),
    ]);
    provider.destroy();
    const amount = Number(formatEther(wei));
    const price = await getPrice(nativeSymbol.toLowerCase());
    _evmProbeFailedUntil.delete(chainKey);
    if (price <= 0) return { chainKey, tier, usdMicros: 0n, ok: false, reason: 'no-price' };
    return { chainKey, tier, usdMicros: toMicrosUsd(amount, price), ok: true };
  } catch (e) {
    _evmProbeFailedUntil.set(chainKey, Date.now() + EVM_PROBE_FAIL_COOLDOWN_MS);
    return { chainKey, tier, usdMicros: 0n, ok: false, reason: errMsg(e) };
  }
}

async function probeSui(
  addr: string,
  graphqlUrl: string,
  network: 'mainnet' | 'testnet',
  tier: NetworkTier,
): Promise<ChainBalanceProbe> {
  try {
    // fresh SuiGraphQLClient (not the shared session one) is intentional - we only call
    // listCoins here, which doesn't need the installGetObjectsChunking wrapper. probing
    // non-active vaults from VaultPicker would also need per-vault clients, so always
    // building a fresh one keeps the path simple.
    // lazy-import to keep the SW cold-load bundle lean.
    const { SuiGraphQLClient } = await import('@mysten/sui/graphql');
    const client = new SuiGraphQLClient({ url: graphqlUrl, network });
    let totalUsdMicros = 0n;
    let cursor: string | null = null;
    for (;;) {
      // use the base listCoins (res.objects with .type / .objectId / .balance fields)
      // which is what the rest of the codebase uses. `client.core.listCoins` returns a
      // different Coin shape that lacks coinType at the top level.
      const res = await client.listCoins({
        owner: addr,
        ...(cursor ? { cursor } : {}),
      });
      for (const o of res.objects) {
        const sym = coinTypeToSymbol(o.type);
        if (!sym) continue;
        const decimals = coinTypeToDecimals(o.type);
        const amount = Number(BigInt(o.balance ?? '0')) / 10 ** decimals;
        const price = await getPrice(sym);
        totalUsdMicros += toMicrosUsd(amount, price);
      }
      if (!res.hasNextPage) break;
      cursor = res.cursor ?? null;
    }
    return { chainKey: 'sui', tier, usdMicros: totalUsdMicros, ok: true };
  } catch (e) {
    return { chainKey: 'sui', tier, usdMicros: 0n, ok: false, reason: errMsg(e) };
  }
}

async function probeSolana(addr: string, rpcUrl: string, tier: NetworkTier): Promise<ChainBalanceProbe> {
  try {
    const conn = new Connection(rpcUrl, 'confirmed');
    const lamports = await conn.getBalance(new PublicKey(addr));
    const sol = lamports / 1_000_000_000;
    const price = await getPrice('sol');
    return { chainKey: 'sol', tier, usdMicros: toMicrosUsd(sol, price), ok: true };
  } catch (e) {
    return { chainKey: 'sol', tier, usdMicros: 0n, ok: false, reason: errMsg(e) };
  }
}

async function probeSolanaSpl(addr: string, rpcUrl: string, tier: NetworkTier): Promise<ChainBalanceProbe> {
  try {
    const { listSolanaSplBalances } = await import('@/background/chains/solana-list-spl');
    const conn = new Connection(rpcUrl, 'confirmed');
    const balances = await listSolanaSplBalances(addr, conn);
    let totalUsdMicros = 0n;
    for (const row of balances) {
      const known = SOLANA_KNOWN_SPL_MINTS[row.mint];
      if (!known) continue;
      const amount = Number(BigInt(row.balanceRaw)) / 10 ** row.decimals;
      const price = await getPrice(known.symbol);
      if (!price || price <= 0) continue;
      totalUsdMicros += toMicrosUsd(amount, price);
    }
    return { chainKey: 'sol-spl', tier, usdMicros: totalUsdMicros, ok: true };
  } catch (e) {
    return { chainKey: 'sol-spl', tier, usdMicros: 0n, ok: false, reason: errMsg(e) };
  }
}

async function probeBtc(addr: string, esploraBase: string, tier: NetworkTier): Promise<ChainBalanceProbe> {
  try {
    const r = await fetch(`${esploraBase}/address/${addr}`);
    if (!r.ok) throw new Error(`esplora ${r.status}`);
    const json = (await r.json()) as {
      chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
    };
    const sats = json.chain_stats.funded_txo_sum - json.chain_stats.spent_txo_sum;
    const btc = sats / 100_000_000;
    const price = await getPrice('btc');
    return { chainKey: 'btc', tier, usdMicros: toMicrosUsd(btc, price), ok: true };
  } catch (e) {
    return { chainKey: 'btc', tier, usdMicros: 0n, ok: false, reason: errMsg(e) };
  }
}

async function probeDeSo(addr: string, nodeUrl: string): Promise<ChainBalanceProbe> {
  // deso has no canonical testnet, always tag mainnet.
  const tier: NetworkTier = 'mainnet';
  try {
    const r = await fetch(`${nodeUrl.replace(/\/$/, '')}/api/v0/get-users-stateless`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ PublicKeysBase58Check: [addr], SkipForLeaderboard: true }),
    });
    if (!r.ok) throw new Error(`deso ${r.status}`);
    const json = (await r.json()) as { UserList?: Array<{ BalanceNanos?: number }> };
    const nanos = json.UserList?.[0]?.BalanceNanos ?? 0;
    const deso = nanos / 1_000_000_000;
    const price = await getPrice('deso');
    return { chainKey: 'deso', tier, usdMicros: toMicrosUsd(deso, price), ok: true };
  } catch (e) {
    return { chainKey: 'deso', tier, usdMicros: 0n, ok: false, reason: errMsg(e) };
  }
}

async function probeAptos(addr: string, fullnodeUrl: string, tier: NetworkTier): Promise<ChainBalanceProbe> {
  try {
    // lazy-import to keep the SW cold-load bundle lean.
    const { Aptos, AptosConfig, Network } = await import('@aptos-labs/ts-sdk');
    const cfg = new AptosConfig({ network: Network.MAINNET, fullnode: fullnodeUrl });
    const aptos = new Aptos(cfg);
    const balance = await aptos.getAccountAPTAmount({ accountAddress: addr });
    const apt = Number(balance) / 100_000_000;
    const price = await getPrice('apt');
    return { chainKey: 'apt', tier, usdMicros: toMicrosUsd(apt, price), ok: true };
  } catch (e) {
    return { chainKey: 'apt', tier, usdMicros: 0n, ok: false, reason: errMsg(e) };
  }
}

// ---------------------------------------------------------------------------
// EVM chain list for total-value probing
// ---------------------------------------------------------------------------

const TESTNET_NAME_KEYWORDS = ['testnet', 'goerli', 'sepolia', 'holesky', 'mumbai', 'devnet', 'fuji', 'alfajores'];

function evmTierByName(net: EvmNetwork): NetworkTier {
  const nameLower = net.name.toLowerCase();
  return TESTNET_NAME_KEYWORDS.some((kw) => nameLower.includes(kw)) ? 'testnet' : 'mainnet';
}

/**
 * returns all EVM networks worth probing tagged with their tier. built-in EVM rows are
 * all mainnet; custom rows can be either tier and are detected via name keywords (the
 * user's row label is what we have to go on - no explicit `isTestnet` flag).
 *
 * unlike the old `evmChainsToProbe`, this does NOT drop testnet rows - they're handed
 * to the probe with `tier: 'testnet'` so the aggregator can sum them into the testnet
 * total. mainnet-only consumers can filter on `.tier === 'mainnet'`.
 */
async function evmChainsToProbeAllTiers(): Promise<Array<{ net: EvmNetwork; tier: NetworkTier }>> {
  const customEvms = await getCustomNetworks().then((s) => s.evm).catch(() => [] as EvmNetwork[]);
  const merged = mergeEvmNetworksWithCustom(customEvms);
  return merged.map((net) => ({ net, tier: evmTierByName(net) }));
}

// ---------------------------------------------------------------------------
// pure probe dispatcher (no session / no vault context)
// ---------------------------------------------------------------------------

/**
 * given a per-dwallet address bundle + resolved network endpoints, fan out every
 * chain probe and return one `ChainBalanceProbe` per chainKey for that ONE dWallet.
 *
 * pure: doesn't touch `chrome.storage`, doesn't read the session, doesn't look at
 * vault state. caller passes in everything via `bundle` so this can be reused
 * outside the vault context (e.g. ChromaLab leaderboard, where the input is just
 * a dWallet id from anyone on the network).
 *
 * - EVM: fans out across `bundle.evmChains`, batched at 4 parallel to avoid
 *   hammering public RPCs.
 * - non-EVM: fired together (each chain is a different protocol/host).
 * - chains whose address or RPC is missing are silently skipped. all probes are
 *   wrapped in try/catch upstream, so a single chain failure never blocks others.
 */
export async function probeAllChainsForAddresses(
  addresses: DwalletCapChainAddresses,
  bundle: ChainProbeNetworkBundle,
): Promise<ChainBalanceProbe[]> {
  const out: ChainBalanceProbe[] = [];

  /** run probes in batches of `batchSize` to avoid thundering-herd on public RPCs. */
  async function runBatched(probes: Promise<ChainBalanceProbe>[], batchSize: number): Promise<void> {
    for (let i = 0; i < probes.length; i += batchSize) {
      const batch = probes.slice(i, i + batchSize);
      const results = await Promise.all(batch);
      for (const p of results) out.push(p);
    }
  }

  // --- EVM: fan out across every row in bundle.evmChains (mainnet + user-added testnets),
  //     cap at 4 parallel probes per dwallet to avoid hammering public RPCs ---
  if (addresses.evm) {
    const evmProbes: Promise<ChainBalanceProbe>[] = bundle.evmChains.map(({ net, tier }) =>
      probeEvm(addresses.evm!, net.rpcUrl, net.id, net.symbol, net.chainId, tier),
    );
    await runBatched(evmProbes, 4);
  }

  // --- non-EVM chains: fire together (each is a different protocol/host) ---
  const otherProbes: Promise<ChainBalanceProbe>[] = [];

  if (addresses.sui) {
    otherProbes.push(probeSui(addresses.sui, bundle.suiGraphqlUrl, bundle.suiNetwork, bundle.suiTier));
  }

  if (addresses.solana && bundle.solRpcUrl) {
    otherProbes.push(probeSolana(addresses.solana, bundle.solRpcUrl, bundle.solTier));
    otherProbes.push(probeSolanaSpl(addresses.solana, bundle.solRpcUrl, bundle.solTier));
  }

  if (addresses.btcP2wpkh && bundle.btcEsplora) {
    otherProbes.push(
      probeBtc(addresses.btcP2wpkh, bundle.btcEsplora, bundle.btcTier).then((p) => ({ ...p, chainKey: 'btc-p2wpkh' })),
    );
  }

  if (addresses.btcP2tr && bundle.btcEsplora) {
    otherProbes.push(
      probeBtc(addresses.btcP2tr, bundle.btcEsplora, bundle.btcTier).then((p) => ({ ...p, chainKey: 'btc-p2tr' })),
    );
  }

  if (addresses.aptos && bundle.aptFullnode) {
    otherProbes.push(probeAptos(addresses.aptos, bundle.aptFullnode, bundle.aptTier));
  }

  if (addresses.deso && bundle.desoNodeUrl) {
    otherProbes.push(probeDeSo(addresses.deso, bundle.desoNodeUrl));
  }

  const otherResults = await Promise.all(otherProbes);
  for (const p of otherResults) out.push(p);
  return out;
}

/**
 * resolve the default mainnet endpoint bundle without requiring a vault context.
 * the ChromaLab leaderboard uses this since the dWallets it aggregates may belong
 * to ANY owner - there's no per-dwallet network preference to honor, so we just
 * use chromatika's built-in mainnet defaults.
 *
 * every tier is `'mainnet'` and the EVM list is filtered to mainnet-only rows;
 * the leaderboard intentionally only sums mainnet for the public score.
 */
export async function resolveDefaultNetworkBundle(): Promise<ChainProbeNetworkBundle> {
  const suiNetwork: SuiNetworkId = 'mainnet';
  const suiGraphqlUrl = graphqlUrlForNetwork(suiNetwork);

  // resolveSolanaRpcUrl accepts a Solana settings row; passing no override lets it
  // resolve to chromatika's default mainnet endpoint (helius if VITE_HELIUS_KEY set,
  // else public solana RPC).
  const solRpcUrl = resolveSolanaRpcUrl({
    solNetworkId: 'sol-mainnet',
    customRpcUrl: null,
    priorityFeeMicroLamportsPerCu: 0,
    commitment: 'confirmed',
    maxRetries: 3,
    skipPreflight: false,
  });

  const btcNet = BUILTIN_BITCOIN.find((n) => n.id === 'btc-mainnet');
  const btcEsplora = btcNet?.esploraUrl ?? null;

  const aptNet = BUILTIN_APTOS.find((n) => n.id === 'apt-mainnet');
  const aptFullnode = aptNet?.rpcUrl ?? null;

  const desoNodeUrl = await getDeSoNodeUrl().catch(() => null);

  const allTiers = await evmChainsToProbeAllTiers();
  // leaderboard path: mainnet-only EVM rows
  const evmChains = allTiers.filter((r) => r.tier === 'mainnet');

  return {
    suiNetwork,
    suiGraphqlUrl,
    suiTier: 'mainnet',
    solRpcUrl,
    solTier: 'mainnet',
    btcEsplora,
    btcTier: 'mainnet',
    aptFullnode,
    aptTier: 'mainnet',
    desoNodeUrl,
    evmChains,
  };
}

// ---------------------------------------------------------------------------
// main dispatcher (vault context)
// ---------------------------------------------------------------------------

/**
 * default implementation for VaultTotalDeps.probeAllChainsForVault.
 *
 * reads network settings from chrome.storage via getDwalletNetworkSettings(vaultId), which
 * returns { evmChainId, suiNetworkId, solana, aptNetworkId, btcNetworkId }. RPC URLs are
 * resolved as follows:
 *   - EVM:     ALL mainnet EVM chains (BUILTIN_EVM + custom, testnets excluded),
 *              capped at 4 in parallel per dwallet to avoid hammering public RPCs.
 *              each chain uses its own native symbol for pricing (ETH, POL, BNB, etc).
 *   - Sui:     graphqlUrlForNetwork(registrySuiIdToSuiNetworkId(suiNetworkId))
 *   - Solana:  resolveSolanaRpcUrl(dwNet.solana) (respects customRpcUrl override)
 *   - BTC:     BUILTIN_BITCOIN.find(n => n.id === btcNetworkId).esploraUrl
 *   - Aptos:   BUILTIN_APTOS.find(n => n.id === aptNetworkId).rpcUrl
 *   - DeSo:    getDeSoNodeUrl() (user-overridable, defaults to node.deso.org)
 *
 * chains whose address or RPC is missing are silently skipped. all probes are wrapped in
 * try/catch so a single chain failure never blocks others.
 *
 * delegates the actual per-dwallet probe loop to the shared, pure
 * `probeAllChainsForAddresses` helper above so the leaderboard reuses the same code path.
 */
export async function probeAllChainsForVaultDefault(
  vaultId: string,
  dwallets: VaultDwalletAddresses[],
): Promise<ChainBalanceProbe[]> {
  if (dwallets.length === 0) return [];

  // read network settings from chrome.storage (async, safe to call outside session).
  let dwNet: Awaited<ReturnType<typeof getDwalletNetworkSettings>>;
  try {
    dwNet = await getDwalletNetworkSettings(vaultId, { network: 'mainnet' });
  } catch {
    return [];
  }

  // resolve non-EVM endpoint strings using the vault's stored prefs.
  const suiNetwork: SuiNetworkId = registrySuiIdToSuiNetworkId(dwNet.suiNetworkId);
  const suiGraphqlUrl = graphqlUrlForNetwork(suiNetwork);
  const suiTier: NetworkTier = dwNet.suiNetworkId === 'sui-mainnet' ? 'mainnet' : 'testnet';
  const solRpcUrl = resolveSolanaRpcUrl(dwNet.solana);
  const solTier: NetworkTier = dwNet.solana.solNetworkId === 'sol-mainnet' ? 'mainnet' : 'testnet';

  const btcNet = BUILTIN_BITCOIN.find((n) => n.id === dwNet.btcNetworkId);
  const btcEsplora = btcNet?.esploraUrl ?? null;
  const btcTier: NetworkTier = dwNet.btcNetworkId === 'btc-mainnet' ? 'mainnet' : 'testnet';

  const aptNet = BUILTIN_APTOS.find((n) => n.id === dwNet.aptNetworkId);
  const aptFullnode = aptNet?.rpcUrl ?? null;
  const aptTier: NetworkTier = dwNet.aptNetworkId === 'apt-mainnet' ? 'mainnet' : 'testnet';

  const desoNodeUrl = await getDeSoNodeUrl().catch(() => null);

  // build the list of EVM networks once, shared across all dwallets. user-added
  // testnet rows get included with `tier: 'testnet'` so the aggregator can sum
  // them into the testnet headline.
  const evmChains = await evmChainsToProbeAllTiers();

  const bundle: ChainProbeNetworkBundle = {
    suiNetwork,
    suiGraphqlUrl,
    suiTier,
    solRpcUrl,
    solTier,
    btcEsplora,
    btcTier,
    aptFullnode,
    aptTier,
    desoNodeUrl,
    evmChains,
  };

  // collect probes for all dwallets (one dWallet per curve; merge results by chainKey).
  // we use a map so that if both SECP256K1 and ED25519 expose a sui address, we sum them.
  // EVM: a dWallet has one address on all chains (same secp256k1-derived address), so each
  // (address, evmChain) pair gets a unique chainKey like "evm-1", "evm-8453", etc.
  // tier is captured on first sight per chainKey - all rows for a given chain are the same tier.
  const chainTotals = new Map<
    string,
    { tier: NetworkTier; usdMicros: bigint; ok: boolean; reason?: string }
  >();

  function mergeProbe(p: ChainBalanceProbe) {
    const existing = chainTotals.get(p.chainKey);
    if (!existing) {
      chainTotals.set(p.chainKey, { tier: p.tier, usdMicros: p.usdMicros, ok: p.ok, reason: p.reason });
      return;
    }
    chainTotals.set(p.chainKey, {
      tier: existing.tier,
      usdMicros: existing.usdMicros + p.usdMicros,
      ok: existing.ok && p.ok,
      reason: existing.reason ?? p.reason,
    });
  }

  for (const dwallet of dwallets) {
    const probes = await probeAllChainsForAddresses(dwallet.addresses, bundle);
    for (const p of probes) mergeProbe(p);
  }

  return Array.from(chainTotals.entries()).map(([chainKey, v]) => ({
    chainKey,
    tier: v.tier,
    usdMicros: v.usdMicros,
    ok: v.ok,
    reason: v.reason,
  }));
}
