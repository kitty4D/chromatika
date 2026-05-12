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

import { JsonRpcProvider, formatEther } from 'ethers';
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

/**
 * resolved set of mainnet endpoints used by every chain probe.
 *
 * shared shape between the per-vault path (where each field is resolved from the vault's
 * stored network preference) and the leaderboard path (where the active vault's preference
 * is the default for ALL probes regardless of which dwallet we're aggregating). lifted to a
 * dedicated type so `probeAllChainsForAddresses` is a pure function of `(addresses, bundle)`
 * and can be reused from outside the vault context.
 */
export type ChainProbeNetworkBundle = {
  suiNetwork: SuiNetworkId;
  suiGraphqlUrl: string;
  solRpcUrl: string | null;
  btcEsplora: string | null;
  aptFullnode: string | null;
  desoNodeUrl: string | null;
  evmChains: EvmNetwork[];
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

async function probeEvm(addr: string, rpcUrl: string, chainKey: string, nativeSymbol: string): Promise<ChainBalanceProbe> {
  try {
    const provider = new JsonRpcProvider(rpcUrl);
    const wei = await provider.getBalance(addr);
    const amount = Number(formatEther(wei));
    const price = await getPrice(nativeSymbol.toLowerCase());
    if (price <= 0) return { chainKey, usdMicros: 0n, ok: false, reason: 'no-price' };
    return { chainKey, usdMicros: toMicrosUsd(amount, price), ok: true };
  } catch (e) {
    return { chainKey, usdMicros: 0n, ok: false, reason: errMsg(e) };
  }
}

async function probeSui(addr: string, graphqlUrl: string, network: 'mainnet' | 'testnet'): Promise<ChainBalanceProbe> {
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
    return { chainKey: 'sui', usdMicros: totalUsdMicros, ok: true };
  } catch (e) {
    return { chainKey: 'sui', usdMicros: 0n, ok: false, reason: errMsg(e) };
  }
}

async function probeSolana(addr: string, rpcUrl: string): Promise<ChainBalanceProbe> {
  try {
    const conn = new Connection(rpcUrl, 'confirmed');
    const lamports = await conn.getBalance(new PublicKey(addr));
    const sol = lamports / 1_000_000_000;
    const price = await getPrice('sol');
    return { chainKey: 'sol', usdMicros: toMicrosUsd(sol, price), ok: true };
  } catch (e) {
    return { chainKey: 'sol', usdMicros: 0n, ok: false, reason: errMsg(e) };
  }
}

async function probeSolanaSpl(addr: string, rpcUrl: string): Promise<ChainBalanceProbe> {
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
    return { chainKey: 'sol-spl', usdMicros: totalUsdMicros, ok: true };
  } catch (e) {
    return { chainKey: 'sol-spl', usdMicros: 0n, ok: false, reason: errMsg(e) };
  }
}

async function probeBtc(addr: string, esploraBase: string): Promise<ChainBalanceProbe> {
  try {
    const r = await fetch(`${esploraBase}/address/${addr}`);
    if (!r.ok) throw new Error(`esplora ${r.status}`);
    const json = (await r.json()) as {
      chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
    };
    const sats = json.chain_stats.funded_txo_sum - json.chain_stats.spent_txo_sum;
    const btc = sats / 100_000_000;
    const price = await getPrice('btc');
    return { chainKey: 'btc', usdMicros: toMicrosUsd(btc, price), ok: true };
  } catch (e) {
    return { chainKey: 'btc', usdMicros: 0n, ok: false, reason: errMsg(e) };
  }
}

async function probeDeSo(addr: string, nodeUrl: string): Promise<ChainBalanceProbe> {
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
    return { chainKey: 'deso', usdMicros: toMicrosUsd(deso, price), ok: true };
  } catch (e) {
    return { chainKey: 'deso', usdMicros: 0n, ok: false, reason: errMsg(e) };
  }
}

async function probeAptos(addr: string, fullnodeUrl: string): Promise<ChainBalanceProbe> {
  try {
    // lazy-import to keep the SW cold-load bundle lean.
    const { Aptos, AptosConfig, Network } = await import('@aptos-labs/ts-sdk');
    const cfg = new AptosConfig({ network: Network.MAINNET, fullnode: fullnodeUrl });
    const aptos = new Aptos(cfg);
    const balance = await aptos.getAccountAPTAmount({ accountAddress: addr });
    const apt = Number(balance) / 100_000_000;
    const price = await getPrice('apt');
    return { chainKey: 'apt', usdMicros: toMicrosUsd(apt, price), ok: true };
  } catch (e) {
    return { chainKey: 'apt', usdMicros: 0n, ok: false, reason: errMsg(e) };
  }
}

// ---------------------------------------------------------------------------
// EVM chain list for total-value probing
// ---------------------------------------------------------------------------

const TESTNET_NAME_KEYWORDS = ['testnet', 'goerli', 'sepolia', 'holesky', 'mumbai', 'devnet', 'fuji', 'alfajores'];

/**
 * returns all EVM networks worth probing for mainnet balance (built-ins + custom,
 * testnets filtered out). built-in EVM rows are all mainnet so the name-keyword
 * check is really just a safety net for custom user-added rows.
 */
async function evmChainsToProbe(): Promise<EvmNetwork[]> {
  const customEvms = await getCustomNetworks().then((s) => s.evm).catch(() => [] as EvmNetwork[]);
  const merged = mergeEvmNetworksWithCustom(customEvms);
  return merged.filter((n) => {
    const nameLower = n.name.toLowerCase();
    return !TESTNET_NAME_KEYWORDS.some((kw) => nameLower.includes(kw));
  });
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

  // --- EVM: fan out over all mainnet chains, cap at 4 parallel probes per dwallet ---
  if (addresses.evm) {
    const evmProbes: Promise<ChainBalanceProbe>[] = bundle.evmChains.map((net) =>
      probeEvm(addresses.evm!, net.rpcUrl, net.id, net.symbol),
    );
    await runBatched(evmProbes, 4);
  }

  // --- non-EVM chains: fire together (each is a different protocol/host) ---
  const otherProbes: Promise<ChainBalanceProbe>[] = [];

  if (addresses.sui) {
    otherProbes.push(probeSui(addresses.sui, bundle.suiGraphqlUrl, bundle.suiNetwork));
  }

  if (addresses.solana && bundle.solRpcUrl) {
    otherProbes.push(probeSolana(addresses.solana, bundle.solRpcUrl));
    otherProbes.push(probeSolanaSpl(addresses.solana, bundle.solRpcUrl));
  }

  if (addresses.btcP2wpkh && bundle.btcEsplora) {
    otherProbes.push(probeBtc(addresses.btcP2wpkh, bundle.btcEsplora).then((p) => ({ ...p, chainKey: 'btc-p2wpkh' })));
  }

  if (addresses.btcP2tr && bundle.btcEsplora) {
    otherProbes.push(probeBtc(addresses.btcP2tr, bundle.btcEsplora).then((p) => ({ ...p, chainKey: 'btc-p2tr' })));
  }

  if (addresses.aptos && bundle.aptFullnode) {
    otherProbes.push(probeAptos(addresses.aptos, bundle.aptFullnode));
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

  const evmChains = await evmChainsToProbe();

  return {
    suiNetwork,
    suiGraphqlUrl,
    solRpcUrl,
    btcEsplora,
    aptFullnode,
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
  const solRpcUrl = resolveSolanaRpcUrl(dwNet.solana);

  const btcNet = BUILTIN_BITCOIN.find((n) => n.id === dwNet.btcNetworkId);
  const btcEsplora = btcNet?.esploraUrl ?? null;

  const aptNet = BUILTIN_APTOS.find((n) => n.id === dwNet.aptNetworkId);
  const aptFullnode = aptNet?.rpcUrl ?? null;

  const desoNodeUrl = await getDeSoNodeUrl().catch(() => null);

  // build the list of mainnet EVM networks once, shared across all dwallets.
  const evmChains = await evmChainsToProbe();

  const bundle: ChainProbeNetworkBundle = {
    suiNetwork,
    suiGraphqlUrl,
    solRpcUrl,
    btcEsplora,
    aptFullnode,
    desoNodeUrl,
    evmChains,
  };

  // collect probes for all dwallets (one dWallet per curve; merge results by chainKey).
  // we use a map so that if both SECP256K1 and ED25519 expose a sui address, we sum them.
  // EVM: a dWallet has one address on all chains (same secp256k1-derived address), so each
  // (address, evmChain) pair gets a unique chainKey like "evm-1", "evm-8453", etc.
  const chainTotals = new Map<string, { usdMicros: bigint; ok: boolean; reason?: string }>();

  function mergeProbe(p: ChainBalanceProbe) {
    const existing = chainTotals.get(p.chainKey);
    if (!existing) {
      chainTotals.set(p.chainKey, { usdMicros: p.usdMicros, ok: p.ok, reason: p.reason });
      return;
    }
    chainTotals.set(p.chainKey, {
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
    usdMicros: v.usdMicros,
    ok: v.ok,
    reason: v.reason,
  }));
}
