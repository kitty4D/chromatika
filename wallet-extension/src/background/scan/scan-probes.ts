/**
 * per-chain activity probes for the scan service.
 *
 * each probe is a thin wrapper around the chain's native rpc that returns:
 *   - native balance in smallest units (lamports / wei / mist / sats)
 *   - tx count (when cheaply available - skipped when it would cost an extra rpc)
 *   - hasActivity bool (balance > 0 OR tx count > 0)
 *
 * probes are built lazily by the orchestrator when the user opts in to a chain. the orchestrator
 * does the timeboxing + retry + concurrency limiting; probe implementations stay simple.
 *
 * **rpc isolation**: each probe constructs its own client / provider (no `getSession()` access)
 * so the scan can run before any vault is unlocked / persisted. that's the whole point of using
 * the scan during import / restore.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { Contract, JsonRpcProvider } from 'ethers';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import {
  BUILTIN_SOLANA,
  BUILTIN_SUI,
  resolveBuiltinSolanaPreset,
  type EvmNetwork,
} from '@/config/networks';
import { SUPER_PRO_CHAINS, type ScanChainEntry } from '@/config/scan-chains';
import { queryTransactionBlocksGraphQL } from '@/background/sui-client';
import { encodeDeSoAddress } from '@/background/chains/deso/deso-address';
import { getUsersStateless } from '@/background/chains/deso/deso-node-client';
import { encodeCosmosAddress } from '@/background/chains/cosmos/cosmos-address';
import { encodeSs58Address } from '@/background/chains/polkadot/polkadot-address';
import type { ChainProbe, ScanCandidate } from '@/background/scan/scan-types';

/** native sui coin type. */
const SUI_TYPE = '0x2::sui::SUI';

/** lazily-cached graphql client per sui registry id - so multiple candidates share one connection. */
const _suiClientByRegistryId = new Map<string, SuiGraphQLClient>();

function getSuiGraphqlClient(registryId: string): SuiGraphQLClient {
  let c = _suiClientByRegistryId.get(registryId);
  if (c) return c;
  const def = BUILTIN_SUI.find((n) => n.id === registryId);
  if (!def) throw new Error(`unknown sui registry id: ${registryId}`);
  // graphql network field tracks the upstream sdk's "mainnet" | "testnet" pair; devnet uses
  // 'testnet' for sdk compatibility, matching `createSuiGraphQLClientFromRegistryNetworkId`.
  const network = registryId === 'sui-mainnet' ? 'mainnet' : 'testnet';
  c = new SuiGraphQLClient({
    url: def.rpcUrl,
    network,
  });
  _suiClientByRegistryId.set(registryId, c);
  return c;
}

function lamportsToDisplay(lamports: bigint, decimals: number, symbol: string): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = lamports / divisor;
  const frac = lamports % divisor;
  if (frac === 0n) return `${whole.toString()} ${symbol}`;
  // 4 sig figs of fractional precision is plenty for an at-a-glance scan row.
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr} ${symbol}` : `${whole} ${symbol}`;
}

/* ============================ sui ============================ */

export function makeSuiProbe(registryId: string): ChainProbe {
  const def = BUILTIN_SUI.find((n) => n.id === registryId)!;
  return {
    chainId: registryId,
    chainName: def.name,
    kind: 'sui',
    addressFor: (c: ScanCandidate) => c.suiAddress,
    probe: async (address: string) => {
      const client = getSuiGraphqlClient(registryId);
      // balance + activity in parallel - both ride the same graphql endpoint.
      const [balRes, txRows] = await Promise.allSettled([
        client.getBalance({ owner: address, coinType: SUI_TYPE }),
        // activity check: 1 tx is enough to mark hasActivity. limit=1 to keep payload tiny.
        queryTransactionBlocksGraphQL(client, { filter: { affectedAddress: address }, limit: 1 }),
      ]);
      let balanceSmallest: bigint | undefined;
      let balanceDisplay: string | undefined;
      let hasActivity = false;
      if (balRes.status === 'fulfilled') {
        const raw = balRes.value?.balance?.balance;
        if (typeof raw === 'string' && raw.length) {
          balanceSmallest = BigInt(raw);
          balanceDisplay = lamportsToDisplay(balanceSmallest, 9, 'SUI');
          if (balanceSmallest > 0n) hasActivity = true;
        }
      }
      let txCount: number | undefined;
      if (txRows.status === 'fulfilled') {
        txCount = txRows.value.length; // capped at limit=1, so 0 or 1
        if (txCount > 0) hasActivity = true;
      }
      const errorMsgs = [balRes, txRows]
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
      return {
        balanceSmallest,
        balanceDisplay,
        txCount,
        hasActivity,
        ...(errorMsgs.length ? { error: errorMsgs.join('; ') } : {}),
      };
    },
  };
}

/* ============================ solana ============================ */

const _solConnByCluster = new Map<string, Connection>();
function getSolanaConn(registryId: string): Connection {
  let c = _solConnByCluster.get(registryId);
  if (c) return c;
  const def = resolveBuiltinSolanaPreset(registryId);
  c = new Connection(def.rpcUrl, 'confirmed');
  _solConnByCluster.set(registryId, c);
  return c;
}

export function makeSolanaProbe(registryId: string): ChainProbe {
  const def = BUILTIN_SOLANA.find((n) => n.id === registryId) ?? BUILTIN_SOLANA[0]!;
  return {
    chainId: registryId,
    chainName: def.name,
    kind: 'solana',
    addressFor: (c: ScanCandidate) => c.solanaAddress,
    probe: async (address: string) => {
      const conn = getSolanaConn(registryId);
      const pk = new PublicKey(address);
      // balance + 1 sig in parallel. getSignaturesForAddress with limit=1 is cheap; rpc nodes
      // index this. for inactive addresses returns []; for active returns 1 row.
      const [balRes, sigRes] = await Promise.allSettled([
        conn.getBalance(pk, 'confirmed'),
        conn.getSignaturesForAddress(pk, { limit: 1 }),
      ]);
      let balanceSmallest: bigint | undefined;
      let balanceDisplay: string | undefined;
      let hasActivity = false;
      if (balRes.status === 'fulfilled') {
        balanceSmallest = BigInt(balRes.value);
        balanceDisplay = lamportsToDisplay(balanceSmallest, 9, 'SOL');
        if (balanceSmallest > 0n) hasActivity = true;
      }
      let txCount: number | undefined;
      if (sigRes.status === 'fulfilled') {
        txCount = sigRes.value.length;
        if (txCount > 0) hasActivity = true;
      }
      const errorMsgs = [balRes, sigRes]
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
      return {
        balanceSmallest,
        balanceDisplay,
        txCount,
        hasActivity,
        ...(errorMsgs.length ? { error: errorMsgs.join('; ') } : {}),
      };
    },
  };
}

/* ============================ evm ============================ */

const _evmProviderByChainId = new Map<number, JsonRpcProvider>();
function getEvmProvider(rpcUrl: string, chainId: number): JsonRpcProvider {
  let p = _evmProviderByChainId.get(chainId);
  if (p) return p;
  // staticNetwork hint avoids a `eth_chainId` round-trip on first call.
  p = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  _evmProviderByChainId.set(chainId, p);
  return p;
}

export function makeEvmProbe(net: EvmNetwork | Extract<ScanChainEntry, { kind: 'evm' }>): ChainProbe {
  return {
    chainId: net.id,
    chainName: net.name,
    kind: 'evm',
    addressFor: (c: ScanCandidate) => c.evmAddress,
    probe: async (address: string) => {
      const provider = getEvmProvider(net.rpcUrl, net.chainId);
      const [balRes, nonceRes] = await Promise.allSettled([
        provider.getBalance(address),
        provider.getTransactionCount(address),
      ]);
      let balanceSmallest: bigint | undefined;
      let balanceDisplay: string | undefined;
      let hasActivity = false;
      if (balRes.status === 'fulfilled') {
        balanceSmallest = BigInt(balRes.value);
        // 18 decimals across every evm chain we touch (native gas token).
        balanceDisplay = lamportsToDisplay(balanceSmallest, 18, 'symbol' in net ? net.symbol : 'ETH');
        if (balanceSmallest > 0n) hasActivity = true;
      }
      let txCount: number | undefined;
      if (nonceRes.status === 'fulfilled') {
        txCount = Number(nonceRes.value);
        if (txCount > 0) hasActivity = true;
      }
      const errorMsgs = [balRes, nonceRes]
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
      // unused import guard so eslint doesn't trim it pre-future-token-detection slice.
      void Contract;
      return {
        balanceSmallest,
        balanceDisplay,
        txCount,
        hasActivity,
        ...(errorMsgs.length ? { error: errorMsgs.join('; ') } : {}),
      };
    },
  };
}

/* ============================ bitcoin (esplora) ============================ */

export function makeBitcoinProbe(net: Extract<ScanChainEntry, { kind: 'bitcoin' }>): ChainProbe {
  return {
    chainId: net.id,
    chainName: net.name,
    kind: 'bitcoin',
    // BTC addresses are derived from dwallet public output (p2wpkh / p2tr). HD doesn't currently
    // produce BTC addresses for the activity scan - the scan focuses on the user's main rails.
    // when chromatika ships HD-derived BTC support we plug it in via candidate.btcAddress.
    addressFor: () => undefined,
    probe: async (address: string) => {
      const url = `${net.esploraUrl.replace(/\/$/, '')}/address/${encodeURIComponent(address)}`;
      const res = await fetch(url);
      if (!res.ok) {
        return { hasActivity: false, error: `esplora ${res.status}` };
      }
      const data = (await res.json()) as {
        chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number; tx_count?: number };
        mempool_stats?: { funded_txo_sum?: number; spent_txo_sum?: number; tx_count?: number };
      };
      const chainFunded = BigInt(data.chain_stats?.funded_txo_sum ?? 0);
      const chainSpent = BigInt(data.chain_stats?.spent_txo_sum ?? 0);
      const mempoolFunded = BigInt(data.mempool_stats?.funded_txo_sum ?? 0);
      const mempoolSpent = BigInt(data.mempool_stats?.spent_txo_sum ?? 0);
      const balanceSmallest = chainFunded - chainSpent + (mempoolFunded - mempoolSpent);
      const txCount = (data.chain_stats?.tx_count ?? 0) + (data.mempool_stats?.tx_count ?? 0);
      return {
        balanceSmallest,
        balanceDisplay: lamportsToDisplay(balanceSmallest, 8, 'BTC'),
        txCount,
        hasActivity: balanceSmallest !== 0n || txCount > 0,
      };
    },
  };
}

/* ============================ aptos ============================ */

export function makeAptosProbe(net: Extract<ScanChainEntry, { kind: 'aptos' }>): ChainProbe {
  return {
    chainId: net.id,
    chainName: net.name,
    kind: 'aptos',
    // aptos addresses come from the dwallet's ed25519 public output for ED25519-curve dwallets.
    // HD currently doesn't produce aptos addresses for the activity scan.
    addressFor: () => undefined,
    probe: async (address: string) => {
      const base = net.rpcUrl.replace(/\/$/, '');
      const balUrl = `${base}/accounts/${encodeURIComponent(address)}/resource/0x1::coin::CoinStore%3C0x1::aptos_coin::AptosCoin%3E`;
      const txUrl = `${base}/accounts/${encodeURIComponent(address)}/transactions?limit=1`;
      const [balRes, txRes] = await Promise.allSettled([fetch(balUrl), fetch(txUrl)]);
      let balanceSmallest: bigint | undefined;
      let balanceDisplay: string | undefined;
      let hasActivity = false;
      if (balRes.status === 'fulfilled' && balRes.value.ok) {
        const data = (await balRes.value.json()) as { data?: { coin?: { value?: string } } };
        const v = data.data?.coin?.value;
        if (typeof v === 'string') {
          balanceSmallest = BigInt(v);
          balanceDisplay = lamportsToDisplay(balanceSmallest, 8, 'APT');
          if (balanceSmallest > 0n) hasActivity = true;
        }
      }
      let txCount: number | undefined;
      if (txRes.status === 'fulfilled' && txRes.value.ok) {
        const arr = (await txRes.value.json()) as unknown[];
        txCount = Array.isArray(arr) ? arr.length : 0;
        if (txCount > 0) hasActivity = true;
      }
      const errorMsgs = [balRes, txRes]
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
      return {
        balanceSmallest,
        balanceDisplay,
        txCount,
        hasActivity,
        ...(errorMsgs.length ? { error: errorMsgs.join('; ') } : {}),
      };
    },
  };
}

/* ============================ deso ============================ */

/**
 * encode a candidate's 33-byte secp256k1 compressed pubkey as a DeSo `BC1Y...` mainnet
 * (or testnet equivalent) address. returns undefined when the candidate has no secp pubkey
 * (passkey / seeker / waap / lazor identities don't carry one - their secp lives in the dwallet
 * `public_output` on chain, which the activity scan doesn't fetch).
 */
function desoAddressFromCandidate(c: ScanCandidate, cluster: 'mainnet' | 'testnet'): string | undefined {
  const hex = c.secp256k1CompressedHex;
  if (!hex || hex.length !== 66) return undefined;
  try {
    const bytes = new Uint8Array(33);
    for (let i = 0; i < 33; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return encodeDeSoAddress(bytes, cluster);
  } catch {
    return undefined;
  }
}

export function makeDesoProbe(net: Extract<ScanChainEntry, { kind: 'deso' }>): ChainProbe {
  return {
    chainId: net.id,
    chainName: net.name,
    kind: 'deso',
    addressFor: (c) => desoAddressFromCandidate(c, net.cluster),
    probe: async (address: string) => {
      try {
        const res = await getUsersStateless([address]);
        const user = res.UserList?.find((u) => u.PublicKeyBase58Check === address);
        if (!user) {
          // node returned a response but no entry for this pubkey; treat as no activity.
          return { hasActivity: false };
        }
        const balanceSmallest = BigInt(user.BalanceNanos ?? 0);
        const hasProfile = Boolean(user.ProfileEntryResponse?.Username || user.ProfileEntryResponse?.Description);
        const hasActivity = balanceSmallest > 0n || hasProfile;
        return {
          balanceSmallest,
          balanceDisplay: lamportsToDisplay(balanceSmallest, 9, 'DESO'),
          // tx count isn't surfaced by getUsersStateless; profile presence is the cheaper proxy.
          // future enhancement: hit /api/v0/get-transaction-info to count txs at this pubkey.
          txCount: hasProfile ? 1 : undefined,
          hasActivity,
        };
      } catch (e) {
        return { hasActivity: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/* ============================ cosmos (sdk-based chains) ============================ */

/**
 * encode an HD candidate's compressed secp256k1 pubkey as a Cosmos-SDK bech32 address using
 * the chain's HRP. returns undefined when the candidate carries no secp pubkey (passkey /
 * seeker / waap / lazor identity-bound rows) - their secp lives in the on-chain dwallet
 * `public_output` rather than the candidate.
 */
function cosmosAddressFromCandidate(c: ScanCandidate, hrp: string): string | undefined {
  const hex = c.secp256k1CompressedHex;
  if (!hex || hex.length !== 66) return undefined;
  try {
    const bytes = new Uint8Array(33);
    for (let i = 0; i < 33; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return encodeCosmosAddress(bytes, hrp);
  } catch {
    return undefined;
  }
}

export function makeCosmosProbe(net: Extract<ScanChainEntry, { kind: 'cosmos' }>): ChainProbe {
  return {
    chainId: net.id,
    chainName: net.name,
    kind: 'cosmos',
    addressFor: (c) => cosmosAddressFromCandidate(c, net.bech32Hrp),
    probe: async (address: string) => {
      const base = net.restUrl.replace(/\/$/, '');
      // standard cosmos-sdk REST endpoints (sdk v0.45+).
      // - bank balances: any non-empty `balances` array means the address has been touched.
      // - account: returns 404 / NotFound when the account hasn't been seen on chain.
      const balUrl = `${base}/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}`;
      const acctUrl = `${base}/cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`;
      const [balRes, acctRes] = await Promise.allSettled([fetch(balUrl), fetch(acctUrl)]);

      let balanceSmallest: bigint | undefined;
      let balanceDisplay: string | undefined;
      let hasActivity = false;

      if (balRes.status === 'fulfilled' && balRes.value.ok) {
        const data = (await balRes.value.json()) as { balances?: Array<{ denom: string; amount: string }> };
        const native = data.balances?.find((b) => b.denom === net.nativeDenom);
        if (native) {
          balanceSmallest = BigInt(native.amount);
          balanceDisplay = lamportsToDisplay(balanceSmallest, net.nativeDecimals, net.nativeSymbol);
          if (balanceSmallest > 0n) hasActivity = true;
        }
        // any non-native balance row also counts as activity (e.g. IBC tokens, CW20, LP shares).
        if (!hasActivity && (data.balances?.length ?? 0) > 0) hasActivity = true;
      }

      // account presence: when `/accounts/{addr}` returns 200, the address has been seen.
      // 404 / NotFound means no on-chain history. flip hasActivity even with zero balance because
      // a touched-then-emptied wallet still represents real activity.
      let txCount: number | undefined;
      if (acctRes.status === 'fulfilled' && acctRes.value.ok) {
        try {
          const data = (await acctRes.value.json()) as { account?: { sequence?: string } };
          const seq = data.account?.sequence;
          if (typeof seq === 'string') {
            const n = Number.parseInt(seq, 10);
            if (Number.isFinite(n)) {
              // sequence is the user's outgoing-tx counter. n >= 1 means the user signed at least
              // one tx from this account. doesn't count incoming-only addresses; balances probe
              // above catches those.
              txCount = n;
              if (n > 0) hasActivity = true;
            }
          }
        } catch {
          /* leave txCount undefined */
        }
      }

      const errorMsgs: string[] = [];
      if (balRes.status === 'rejected') {
        errorMsgs.push(balRes.reason instanceof Error ? balRes.reason.message : String(balRes.reason));
      } else if (!balRes.value.ok) {
        // 404 on balances is normal for never-touched addresses; surface only non-404 errors.
        if (balRes.value.status !== 404) errorMsgs.push(`balances ${balRes.value.status}`);
      }
      if (acctRes.status === 'rejected') {
        errorMsgs.push(acctRes.reason instanceof Error ? acctRes.reason.message : String(acctRes.reason));
      }

      return {
        balanceSmallest,
        balanceDisplay,
        txCount,
        hasActivity,
        ...(errorMsgs.length ? { error: errorMsgs.join('; ') } : {}),
      };
    },
  };
}

/* ============================ polkadot / kusama (subscan) ============================ */

function polkadotAddressFromCandidate(c: ScanCandidate, ss58Prefix: number): string | undefined {
  const hex = c.polkadotEd25519PubkeyHex;
  if (!hex || hex.length !== 64) return undefined;
  try {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return encodeSs58Address(bytes, { label: 'auto', prefix: ss58Prefix });
  } catch {
    return undefined;
  }
}

export function makePolkadotProbe(net: Extract<ScanChainEntry, { kind: 'polkadot' }>): ChainProbe {
  return {
    chainId: net.id,
    chainName: net.name,
    kind: 'polkadot',
    addressFor: (c) => polkadotAddressFromCandidate(c, net.ss58Prefix),
    probe: async (address: string) => {
      const url = `${net.subscanApiUrl.replace(/\/$/, '')}/api/scan/account`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: address }),
        });
        if (!res.ok) {
          // 404 / 429 / other: treat as no activity, surface as warning.
          return { hasActivity: false, error: `subscan ${res.status}` };
        }
        const data = (await res.json()) as {
          code?: number;
          message?: string;
          data?: {
            account?: {
              address?: string;
              balance?: string;
              nonce?: number;
              count_extrinsic?: number;
            };
          };
        };
        // subscan envelope: code=0 means success. anything else = error.
        if (typeof data.code === 'number' && data.code !== 0) {
          return { hasActivity: false, error: `subscan: ${data.message ?? 'unknown error'}` };
        }
        const account = data.data?.account;
        if (!account || !account.address) {
          // never-touched address; subscan returns the envelope but no account row.
          return { hasActivity: false };
        }
        // subscan's `balance` is a decimal string in whole units (e.g. "1.234" DOT). convert to
        // smallest using nativeDecimals so the orchestrator's display logic stays uniform.
        let balanceSmallest: bigint | undefined;
        let balanceDisplay: string | undefined;
        if (typeof account.balance === 'string' && account.balance.length > 0) {
          const [whole, frac = ''] = account.balance.split('.');
          const fracPadded = frac.padEnd(net.nativeDecimals, '0').slice(0, net.nativeDecimals);
          const combined = `${whole}${fracPadded}`.replace(/^0+/, '') || '0';
          try {
            balanceSmallest = BigInt(combined);
            balanceDisplay = `${account.balance} ${net.nativeSymbol}`;
          } catch {
            /* leave balance fields undefined */
          }
        }
        const txCount =
          typeof account.count_extrinsic === 'number'
            ? account.count_extrinsic
            : typeof account.nonce === 'number'
              ? account.nonce
              : undefined;
        const hasActivity =
          (balanceSmallest !== undefined && balanceSmallest > 0n)
          || (typeof txCount === 'number' && txCount > 0);
        return { balanceSmallest, balanceDisplay, txCount, hasActivity };
      } catch (e) {
        return { hasActivity: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/* ============================ default chain set ============================ */

/** sui mainnet + solana mainnet + solana devnet - the always-on probes per the plan. */
export function buildDefaultProbes(): ChainProbe[] {
  return [
    makeSuiProbe('sui-mainnet'),
    makeSolanaProbe('sol-mainnet'),
    makeSolanaProbe('sol-devnet'),
  ];
}

/** super-pro probes for the chain ids the user opted into. unknown ids are silently skipped. */
export function buildSuperProProbes(chainIds: string[]): ChainProbe[] {
  const wanted = new Set(chainIds);
  const probes: ChainProbe[] = [];
  for (const c of SUPER_PRO_CHAINS) {
    if (!wanted.has(c.id)) continue;
    if (c.kind === 'evm') probes.push(makeEvmProbe(c));
    else if (c.kind === 'bitcoin') probes.push(makeBitcoinProbe(c));
    else if (c.kind === 'aptos') probes.push(makeAptosProbe(c));
    else if (c.kind === 'deso') probes.push(makeDesoProbe(c));
    else if (c.kind === 'cosmos') probes.push(makeCosmosProbe(c));
    else if (c.kind === 'polkadot') probes.push(makePolkadotProbe(c));
  }
  return probes;
}
