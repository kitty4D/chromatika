/**
 * native balances for a single on-chain address on a portfolio "rail" (for DWalletPortfolioPage).
 */

import { PublicKey } from '@solana/web3.js';
import { ikaCoinType } from '@/background/ika/coins';
import { getSession } from '@/background/session';
import { getDwalletNetworkSettings } from '@/background/network/tier-network-settings';
import { BUILTIN_APTOS, BUILTIN_BITCOIN } from '@/config/networks';
import { getPrices } from '@/background/services/price';
import { suiFromMist, ikaFromBaseUnits } from '@/lib/sui-amount';

const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

export type PortfolioNativeRow = {
  symbol: string;
  name: string;
  balanceRaw: string;
  balanceFormatted: string;
  usdValue: number | null;
};

async function fetchSuiRows(address: string): Promise<PortfolioNativeRow[]> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const ikaType = ikaCoinType(s.ikaClient.ikaConfig);
  const [suiRes, ikaRes] = await Promise.all([
    s.suiClient.getBalance({ owner: address, coinType: SUI_TYPE }),
    s.suiClient.getBalance({ owner: address, coinType: ikaType }).catch(() => ({ balance: { balance: '0' } })),
  ]);
  const suiRaw = suiRes.balance.balance;
  const ikaRaw = ikaRes.balance.balance;
  const suiAmt = suiFromMist(suiRaw);
  const ikaAmt = ikaFromBaseUnits(ikaRaw);
  const prices = await getPrices(['SUI', 'IKA']).catch(() => ({ SUI: null, IKA: null }));
  return [
    {
      symbol: 'SUI',
      name: 'Sui',
      balanceRaw: suiRaw,
      balanceFormatted: suiAmt.toLocaleString(undefined, { maximumFractionDigits: 6 }),
      usdValue: prices.SUI != null ? suiAmt * prices.SUI : null,
    },
    {
      symbol: 'IKA',
      name: 'Ika',
      balanceRaw: ikaRaw,
      balanceFormatted: ikaAmt.toLocaleString(undefined, { maximumFractionDigits: 6 }),
      usdValue: prices.IKA != null ? ikaAmt * prices.IKA : null,
    },
  ];
}

async function fetchSolanaRows(address: string): Promise<PortfolioNativeRow[]> {
  const s0 = getSession();
  if (!s0) throw new Error('Wallet locked');
  const conn = s0.dwalletSolanaConnection;
  const lamports = await conn.getBalance(new PublicKey(address));
  const sol = lamports / 1e9;
  const prices = await getPrices(['SOL']).catch(() => ({ SOL: null }));
  return [
    {
      symbol: 'SOL',
      name: 'Solana',
      balanceRaw: String(lamports),
      balanceFormatted: sol.toLocaleString(undefined, { maximumFractionDigits: 6 }),
      usdValue: prices.SOL != null ? sol * prices.SOL : null,
    },
  ];
}

async function fetchAptosRows(address: string): Promise<PortfolioNativeRow[]> {
  const s0 = getSession();
  if (!s0) throw new Error('Wallet locked');
  const dw = await getDwalletNetworkSettings(s0.activeVaultId, {
    network: s0.network,
    baseChain: s0.activeVaultBaseChain,
  });
  const net = BUILTIN_APTOS.find((n) => n.id === dw.aptNetworkId);
  if (!net) throw new Error('Unknown Aptos network');
  const base = net.rpcUrl.replace(/\/$/, '');
  const rt = encodeURIComponent('0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>');
  const url = `${base}/accounts/${encodeURIComponent(address)}/resource/${rt}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) {
    if (r.status === 404) {
      return [
        {
          symbol: 'APT',
          name: 'Aptos',
          balanceRaw: '0',
          balanceFormatted: '0',
          usdValue: 0,
        },
      ];
    }
    throw new Error(`Aptos balance: HTTP ${r.status}`);
  }
  const json = (await r.json()) as { data?: { coin?: { value?: string } } };
  const raw = json.data?.coin?.value ?? '0';
  const octas = BigInt(raw);
  const apt = Number(octas) / 1e8;
  const prices = await getPrices(['APT']).catch(() => ({ APT: null }));
  return [
    {
      symbol: 'APT',
      name: 'Aptos',
      balanceRaw: raw,
      balanceFormatted: apt.toLocaleString(undefined, { maximumFractionDigits: 6 }),
      usdValue: prices.APT != null ? apt * prices.APT : null,
    },
  ];
}

type EsploraAddressJson = {
  chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
  mempool_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
};

async function fetchBtcSats(address: string): Promise<PortfolioNativeRow[]> {
  const s0 = getSession();
  if (!s0) throw new Error('Wallet locked');
  const dw = await getDwalletNetworkSettings(s0.activeVaultId, {
    network: s0.network,
    baseChain: s0.activeVaultBaseChain,
  });
  const net = BUILTIN_BITCOIN.find((n) => n.id === dw.btcNetworkId);
  if (!net) throw new Error('Unknown Bitcoin network');
  const url = `${net.esploraUrl.replace(/\/$/, '')}/address/${encodeURIComponent(address)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Esplora: HTTP ${r.status}`);
  const data = (await r.json()) as EsploraAddressJson;
  const c = data.chain_stats;
  const m = data.mempool_stats;
  const chainBal =
    (c?.funded_txo_sum ?? 0) - (c?.spent_txo_sum ?? 0) + ((m?.funded_txo_sum ?? 0) - (m?.spent_txo_sum ?? 0));
  const btc = chainBal / 1e8;
  const prices = await getPrices(['BTC']).catch(() => ({ BTC: null }));
  return [
    {
      symbol: 'BTC',
      name: 'Bitcoin',
      balanceRaw: String(chainBal),
      balanceFormatted: btc.toLocaleString(undefined, { maximumFractionDigits: 8 }),
      usdValue: prices.BTC != null ? btc * prices.BTC : null,
    },
  ];
}

export async function fetchPortfolioRailNativeRows(
  rail: 'sui' | 'solana' | 'aptos' | 'btcP2wpkh' | 'btcP2tr',
  address: string,
): Promise<PortfolioNativeRow[]> {
  const trimmed = address.trim();
  if (!trimmed) return [];

  switch (rail) {
    case 'sui':
      return fetchSuiRows(trimmed);
    case 'solana':
      return fetchSolanaRows(trimmed);
    case 'aptos':
      return fetchAptosRows(trimmed);
    case 'btcP2wpkh':
    case 'btcP2tr':
      return fetchBtcSats(trimmed);
    default: {
      const _exhaustive: never = rail;
      return _exhaustive;
    }
  }
}
