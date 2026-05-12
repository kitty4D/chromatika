/**
 * native gas snapshot for dWallet home cards (per active registry networks).
 * lightweight reads only, no token scans.
 */

import { formatUnits } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { Aptos, AptosConfig, Network } from '@aptos-labs/ts-sdk';
import { getActiveNetworks, type ActiveNetworks } from '@/background/network/active-network';
import { getCustomNetworks } from '@/background/network/custom-networks';
import { createSuiGraphQLClientFromRegistryNetworkId } from '@/background/sui-client';
import type { OwnedDWalletCapView } from '@/background/ika/dwallet-discovery';
import {
  BUILTIN_APTOS,
  BUILTIN_BITCOIN,
  BUILTIN_SUI,
  mergeEvmNetworksWithCustom,
  resolveBuiltinSolanaPreset,
} from '@/config/networks';
import { formatNativeGasAmountDisplay } from '@/lib/dwallet-gas-amount-format';
import { evmChainTag } from '@/lib/dwallet-gas-row-labels';
import { sendEvmRpcWithRetry } from '@/background/chains/evm-send';

const SUI_COIN =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

const FETCH_MS = 9_000;
/** evm native reads retry multiple rpcs — keep above worst-case fallback latency */
const EVM_NATIVE_FETCH_MS = 22_000;

function withTimeout<T>(p: Promise<T>, label: string, ms: number = FETCH_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      setTimeout(() => rej(new Error(`${label} timed out`)), ms);
    }),
  ]);
}

export type DwalletHomeGasIcon = 'btc' | 'eth' | 'evm' | 'sui' | 'sol' | 'apt';

export type DwalletHomeGasRow = {
  rowKey: string;
  icon: DwalletHomeGasIcon;
  /** full network name (tooltip / a11y) */
  chainLabel: string;
  /** short label shown in the card grid, e.g. ARB, BTC(seg) */
  chainTag: string;
  address: string | null;
  gasSymbol: string;
  gasAmountFormatted: string;
  priceSymbol: string;
  usdValue: number | null;
};

function orderGasRows(rows: DwalletHomeGasRow[], cap: OwnedDWalletCapView, active: ActiveNetworks): DwalletHomeGasRow[] {
  let pinKey: string | null = null;
  if (cap.curve === 'SECP256K1' && cap.chainAddresses?.evm?.trim()) {
    pinKey = `evm-${active.evmChainId}`;
  } else if (cap.curve === 'ED25519') {
    if (cap.chainAddresses?.sui) pinKey = 'sui';
    else if (cap.chainAddresses?.solana) pinKey = 'sol';
    else if (cap.chainAddresses?.aptos) pinKey = 'apt';
  }
  const hasPin = Boolean(pinKey && rows.some((r) => r.rowKey === pinKey));
  const pinned = hasPin && pinKey ? rows.find((r) => r.rowKey === pinKey)! : null;
  const rest = hasPin && pinKey ? rows.filter((r) => r.rowKey !== pinKey) : [...rows];
  rest.sort((a, b) => {
    const na = a.usdValue != null && Number.isFinite(a.usdValue) && a.usdValue > 0 ? a.usdValue : 0;
    const nb = b.usdValue != null && Number.isFinite(b.usdValue) && b.usdValue > 0 ? b.usdValue : 0;
    const d = nb - na;
    if (d !== 0) return d;
    const lc = a.chainLabel.localeCompare(b.chainLabel);
    if (lc !== 0) return lc;
    return a.rowKey.localeCompare(b.rowKey);
  });
  return pinned ? [pinned, ...rest] : rest;
}

async function esploraSats(base: string, addr: string): Promise<bigint> {
  const url = `${base.replace(/\/$/, '')}/address/${encodeURIComponent(addr)}`;
  const r = await withTimeout(fetch(url, { signal: AbortSignal.timeout(8_000) }), 'btc esplora');
  if (!r.ok) return 0n;
  const j = (await r.json()) as {
    chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
    mempool_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
  };
  const cs = j.chain_stats ?? {};
  const ms = j.mempool_stats ?? {};
  const chain = BigInt((cs.funded_txo_sum ?? 0) - (cs.spent_txo_sum ?? 0));
  const mem = BigInt((ms.funded_txo_sum ?? 0) - (ms.spent_txo_sum ?? 0));
  return chain + mem;
}

function parseEthGetBalanceHex(v: unknown): bigint {
  if (typeof v === 'bigint') return v >= 0n ? v : 0n;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return 0n;
    return BigInt(Math.trunc(v));
  }
  if (typeof v !== 'string') throw new Error(`eth_getBalance: unexpected type ${typeof v}`);
  const s = v.trim();
  if (s === '' || s === '0x') return 0n;
  const hex = s.startsWith('0x') ? s : `0x${s}`;
  return BigInt(hex);
}

/** same rpc fallback stack as sends / token reads — single-primary JsonRpc was dropping arb native when arb1 flaked. */
async function evmNativeWei(chainId: number, primaryRpcUrl: string, addr: string): Promise<bigint> {
  const raw = await sendEvmRpcWithRetry(chainId, primaryRpcUrl, 'eth_getBalance', [addr, 'latest']);
  return parseEthGetBalanceHex(raw);
}

export async function fetchDwalletHomeGasRows(cap: OwnedDWalletCapView): Promise<DwalletHomeGasRow[]> {
  const active = await getActiveNetworks();
  const { evm: customEvm } = await getCustomNetworks();
  const ca = cap.chainAddresses;
  const rows: DwalletHomeGasRow[] = [];
  const priceSyms: string[] = [];
  const balanceByRowKey = new Map<string, number>();

  const pushPrice = (sym: string) => {
    const u = sym.toUpperCase();
    if (!priceSyms.includes(u)) priceSyms.push(u);
  };

  if (cap.curve === 'SECP256K1') {
    const btcNet = BUILTIN_BITCOIN.find((n) => n.id === active.btcNetworkId) ?? BUILTIN_BITCOIN[0];
    const esploraBase = btcNet.esploraUrl;

    if (ca?.btcP2wpkh) {
      try {
        const sats = await esploraSats(esploraBase, ca.btcP2wpkh);
        const btc = Number(sats) / 1e8;
        balanceByRowKey.set('btc-p2wpkh', btc);
        rows.push({
          rowKey: 'btc-p2wpkh',
          icon: 'btc',
          chainLabel: 'Bitcoin (segwit)',
          chainTag: 'BTC(seg)',
          address: ca.btcP2wpkh,
          gasSymbol: 'BTC',
          gasAmountFormatted: formatNativeGasAmountDisplay(String(btc)),
          priceSymbol: 'BTC',
          usdValue: null,
        });
        pushPrice('BTC');
      } catch {
        rows.push({
          rowKey: 'btc-p2wpkh',
          icon: 'btc',
          chainLabel: 'Bitcoin (segwit)',
          chainTag: 'BTC(seg)',
          address: ca.btcP2wpkh,
          gasSymbol: 'BTC',
          gasAmountFormatted: '—',
          priceSymbol: 'BTC',
          usdValue: null,
        });
        pushPrice('BTC');
      }
    }

    if (ca?.btcP2tr) {
      try {
        const sats = await esploraSats(esploraBase, ca.btcP2tr);
        const btc = Number(sats) / 1e8;
        balanceByRowKey.set('btc-p2tr', btc);
        rows.push({
          rowKey: 'btc-p2tr',
          icon: 'btc',
          chainLabel: 'Bitcoin (taproot)',
          chainTag: 'BTC(tr)',
          address: ca.btcP2tr,
          gasSymbol: 'BTC',
          gasAmountFormatted: formatNativeGasAmountDisplay(String(btc)),
          priceSymbol: 'BTC',
          usdValue: null,
        });
        pushPrice('BTC');
      } catch {
        rows.push({
          rowKey: 'btc-p2tr',
          icon: 'btc',
          chainLabel: 'Bitcoin (taproot)',
          chainTag: 'BTC(tr)',
          address: ca.btcP2tr,
          gasSymbol: 'BTC',
          gasAmountFormatted: '—',
          priceSymbol: 'BTC',
          usdValue: null,
        });
        pushPrice('BTC');
      }
    }

    const evmAddr = ca?.evm?.trim();
    if (evmAddr) {
      const nets = mergeEvmNetworksWithCustom(customEvm);
      const eth = nets.find((n) => n.chainId === 1);
      if (eth) {
        try {
          const wei = await withTimeout(evmNativeWei(1, eth.rpcUrl, evmAddr), 'evm native eth', EVM_NATIVE_FETCH_MS);
          const amt = formatUnits(wei, eth.decimals);
          const n = Number(amt);
          balanceByRowKey.set('evm-1', n);
          rows.push({
            rowKey: 'evm-1',
            icon: 'eth',
            chainLabel: eth.name,
            chainTag: evmChainTag(1, eth.symbol),
            address: evmAddr,
            gasSymbol: eth.symbol,
            gasAmountFormatted: formatNativeGasAmountDisplay(amt),
            priceSymbol: eth.symbol,
            usdValue: null,
          });
          pushPrice(eth.symbol);
        } catch {
          rows.push({
            rowKey: 'evm-1',
            icon: 'eth',
            chainLabel: eth.name,
            chainTag: evmChainTag(1, eth.symbol),
            address: evmAddr,
            gasSymbol: eth.symbol,
            gasAmountFormatted: '—',
            priceSymbol: eth.symbol,
            usdValue: null,
          });
          pushPrice(eth.symbol);
        }
      }

      const activeEvmId = active.evmChainId;
      const others = nets
        .filter((n) => n.chainId !== 1)
        .sort((a, b) => {
          if (a.chainId === activeEvmId) return -1;
          if (b.chainId === activeEvmId) return 1;
          return a.name.localeCompare(b.name);
        });
      const results = await Promise.all(
        others.map(async (n) => {
          try {
            const w = await withTimeout(
              evmNativeWei(n.chainId, n.rpcUrl, evmAddr),
              `evm native ${n.chainId}`,
              EVM_NATIVE_FETCH_MS,
            );
            return { n, w, ok: true as const };
          } catch {
            return { n, w: 0n, ok: false as const };
          }
        }),
      );
      for (const { n, w, ok } of results) {
        const rk = `evm-${n.chainId}`;
        if (!ok) {
          rows.push({
            rowKey: rk,
            icon: 'evm',
            chainLabel: n.name,
            chainTag: evmChainTag(n.chainId, n.symbol),
            address: evmAddr,
            gasSymbol: n.symbol,
            gasAmountFormatted: '—',
            priceSymbol: n.symbol,
            usdValue: null,
          });
          pushPrice(n.symbol);
          continue;
        }
        // keep zero rows for the wallet's active evm network so L2 gas shows after rpc (not silently omitted)
        if (w <= 0n && n.chainId !== activeEvmId) continue;
        const amt = formatUnits(w, n.decimals);
        const num = Number(amt);
        balanceByRowKey.set(rk, num);
        rows.push({
          rowKey: rk,
          icon: 'evm',
          chainLabel: n.name,
          chainTag: evmChainTag(n.chainId, n.symbol),
          address: evmAddr,
          gasSymbol: n.symbol,
          gasAmountFormatted: formatNativeGasAmountDisplay(amt),
          priceSymbol: n.symbol,
          usdValue: null,
        });
        pushPrice(n.symbol);
      }
    }
  } else if (cap.curve === 'ED25519') {
    const suiPreset = BUILTIN_SUI.find((n) => n.id === active.suiNetworkId) ?? BUILTIN_SUI[0];
    const solPreset = resolveBuiltinSolanaPreset(active.solNetworkId);
    const aptPreset = BUILTIN_APTOS.find((n) => n.id === active.aptNetworkId) ?? BUILTIN_APTOS[0];

    if (ca?.sui) {
      try {
        const gql = createSuiGraphQLClientFromRegistryNetworkId(active.suiNetworkId);
        const bal = await withTimeout(
          gql.getBalance({ owner: ca.sui, coinType: SUI_COIN }),
          'sui native',
        );
        const raw = BigInt(bal.balance.balance);
        const amt = formatUnits(raw, 9);
        const num = Number(amt);
        balanceByRowKey.set('sui', num);
        rows.push({
          rowKey: 'sui',
          icon: 'sui',
          chainLabel: suiPreset.name,
          chainTag: 'SUI',
          address: ca.sui,
          gasSymbol: 'SUI',
          gasAmountFormatted: formatNativeGasAmountDisplay(amt),
          priceSymbol: 'SUI',
          usdValue: null,
        });
        pushPrice('SUI');
      } catch {
        rows.push({
          rowKey: 'sui',
          icon: 'sui',
          chainLabel: suiPreset.name,
          chainTag: 'SUI',
          address: ca.sui,
          gasSymbol: 'SUI',
          gasAmountFormatted: '—',
          priceSymbol: 'SUI',
          usdValue: null,
        });
        pushPrice('SUI');
      }
    }

    if (ca?.solana) {
      try {
        const conn = new Connection(solPreset.rpcUrl, 'confirmed');
        const pk = new PublicKey(ca.solana);
        const lamports = await withTimeout(conn.getBalance(pk), 'sol native');
        const sol = lamports / 1e9;
        balanceByRowKey.set('sol', sol);
        rows.push({
          rowKey: 'sol',
          icon: 'sol',
          chainLabel: solPreset.name,
          chainTag: 'SOL',
          address: ca.solana,
          gasSymbol: 'SOL',
          gasAmountFormatted: formatNativeGasAmountDisplay(String(sol)),
          priceSymbol: 'SOL',
          usdValue: null,
        });
        pushPrice('SOL');
      } catch {
        rows.push({
          rowKey: 'sol',
          icon: 'sol',
          chainLabel: solPreset.name,
          chainTag: 'SOL',
          address: ca.solana,
          gasSymbol: 'SOL',
          gasAmountFormatted: '—',
          priceSymbol: 'SOL',
          usdValue: null,
        });
        pushPrice('SOL');
      }
    }

    if (ca?.aptos) {
      try {
        const aptos = new Aptos(
          new AptosConfig({
            network: Network.CUSTOM,
            fullnode: aptPreset.rpcUrl,
          }),
        );
        const octas = await withTimeout(aptos.getAccountAPTAmount({ accountAddress: ca.aptos }), 'apt native');
        const apt = octas / 1e8;
        balanceByRowKey.set('apt', apt);
        rows.push({
          rowKey: 'apt',
          icon: 'apt',
          chainLabel: aptPreset.name,
          chainTag: 'APT',
          address: ca.aptos,
          gasSymbol: 'APT',
          gasAmountFormatted: formatNativeGasAmountDisplay(String(apt)),
          priceSymbol: 'APT',
          usdValue: null,
        });
        pushPrice('APT');
      } catch {
        rows.push({
          rowKey: 'apt',
          icon: 'apt',
          chainLabel: aptPreset.name,
          chainTag: 'APT',
          address: ca.aptos,
          gasSymbol: 'APT',
          gasAmountFormatted: '—',
          priceSymbol: 'APT',
          usdValue: null,
        });
        pushPrice('APT');
      }
    }
  }

  const { getPrices } = await import('@/background/services/price');
  const usdBySym = await getPrices(priceSyms);
  for (const row of rows) {
    const px = usdBySym[row.priceSymbol.toUpperCase()];
    if (px == null || px <= 0) continue;
    const raw = balanceByRowKey.get(row.rowKey);
    if (raw != null && Number.isFinite(raw)) {
      row.usdValue = raw * px;
      continue;
    }
    const n = Number.parseFloat(row.gasAmountFormatted.replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    row.usdValue = n * px;
  }

  return orderGasRows(rows, cap, active);
}
