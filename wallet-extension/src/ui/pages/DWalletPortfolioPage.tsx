import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Pencil } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { dwalletTailHex } from '@/lib/dwallet-ui-labels';
import { buildDwalletIndexMap, resolveDwalletLabel, type DwalletCurve } from '@/lib/dwallet-display-names';
import { formatUsd } from '@/lib/sui-amount';
import { buildSolanaExplorerUrl, buildSuiExplorerUrl } from '@/config/explorers';
import {
  aptosAccountExplorerUrl,
  btcAddressExplorerUrl,
  capObjectExplorerHref,
  dwalletObjectExplorerHref,
  evmAddressExplorerUrl,
} from '@/lib/explorer-href';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import { ReceiveAddressSheet } from '@/ui/components/ReceiveAddressSheet';
import {
  PortfolioAssetTable,
  type NativeAssetRow,
  type PcTokenAssetRow,
  type PortfolioPcTokenConfig,
  type SolanaSplRow,
} from '@/ui/components/PortfolioAssetTable';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import { WrapPcTokenModal } from '@/ui/components/WrapPcTokenModal';
import { UnwrapPcTokenModal } from '@/ui/components/UnwrapPcTokenModal';
import type { Balances, Networks } from '@/ui/types';
import type { DwalletCapChainAddresses } from '@/background/chains/dwallet-derived-addresses';

type PcTokenMarketsList = Awaited<ReturnType<typeof trpc.listPcTokenMarkets.query>>;
type PcMarket = PcTokenMarketsList['markets'][number];

type OwnedCap = Awaited<ReturnType<typeof trpc.listOwnedDWalletCaps.query>>[number];
type NativeRow = Awaited<ReturnType<typeof trpc.portfolioRailBalances.query>>[number];

export type PortfolioChainRail =
  | 'evm'
  | 'btcP2wpkh'
  | 'btcP2tr'
  | 'sui'
  | 'solana'
  | 'aptos';

const RAIL_LABEL: Record<PortfolioChainRail, string> = {
  evm: 'Ethereum',
  btcP2wpkh: 'Bitcoin (segwit)',
  btcP2tr: 'Bitcoin (taproot)',
  sui: 'Sui',
  solana: 'Solana',
  aptos: 'Aptos',
};

function railsForCap(cap: OwnedCap | undefined): PortfolioChainRail[] {
  if (!cap) return [];
  if (cap.curve === 'SECP256K1') {
    const out: PortfolioChainRail[] = ['evm'];
    if (cap.chainAddresses?.btcP2wpkh) out.push('btcP2wpkh');
    if (cap.chainAddresses?.btcP2tr) out.push('btcP2tr');
    return out;
  }
  const out: PortfolioChainRail[] = [];
  if (cap.chainAddresses?.sui) out.push('sui');
  if (cap.chainAddresses?.solana) out.push('solana');
  if (cap.chainAddresses?.aptos) out.push('aptos');
  return out.length > 0 ? out : ['sui'];
}

function addressForRail(cap: OwnedCap, rail: PortfolioChainRail): string | undefined {
  const a = cap.chainAddresses;
  if (!a) return undefined;
  switch (rail) {
    case 'evm':
      return a.evm;
    case 'btcP2wpkh':
      return a.btcP2wpkh;
    case 'btcP2tr':
      return a.btcP2tr;
    case 'sui':
      return a.sui;
    case 'solana':
      return a.solana;
    case 'aptos':
      return a.aptos;
    default:
      return undefined;
  }
}

function railToPortfolioInput(
  rail: PortfolioChainRail,
): 'sui' | 'solana' | 'aptos' | 'btcP2wpkh' | 'btcP2tr' | null {
  if (rail === 'evm') return null;
  return rail;
}

/** little wallet illustration with a frowny face — shown when this vault has zero dWallets. */
function SadWalletGlyph() {
  return (
    <svg
      className="dp-sadWallet"
      viewBox="0 0 120 96"
      width="120"
      height="96"
      role="img"
      aria-label="empty wallet"
    >
      {/* wallet body */}
      <rect
        x="8"
        y="20"
        width="104"
        height="68"
        rx="12"
        ry="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
      />
      {/* fold seam */}
      <path
        d="M8 36 Q60 30 112 36"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        opacity="0.5"
      />
      {/* clasp */}
      <rect
        x="86"
        y="56"
        width="22"
        height="14"
        rx="4"
        ry="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="97" cy="63" r="1.6" fill="currentColor" />
      {/* frowny face */}
      <circle cx="44" cy="60" r="3" fill="currentColor" />
      <circle cx="66" cy="60" r="3" fill="currentColor" />
      <path
        d="M42 78 Q55 70 68 78"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function mapBtcPortfolioRows(rows: NativeRow[], rail: 'btcP2wpkh' | 'btcP2tr'): NativeAssetRow[] {
  const label = rail === 'btcP2wpkh' ? 'Bitcoin (segwit)' : 'Bitcoin (taproot)';
  return rows.map((r) => ({
    symbol: r.symbol,
    name: label,
    balanceFormatted: r.balanceFormatted,
    usdValue: r.usdValue,
    rowKey: `${rail}:${r.symbol}`,
  }));
}

export function DWalletPortfolioPage({
  dwalletId: dwalletIdProp,
  networks,
  balances,
  onBack,
  onOpenSend,
}: {
  dwalletId?: string;
  networks: Networks | null;
  balances: Balances | null;
  onBack?: () => void;
  /** open the Send page; pass a `pcMarketId` to pre-select a hidden-transfer flow for that market. */
  onOpenSend?: (opts?: { pcMarketId?: string }) => void;
}) {
  const [caps, setCaps] = useState<OwnedCap[] | null>(null);
  const [book, setBook] = useState<Awaited<ReturnType<typeof trpc.dwalletAddressBook.query>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rail, setRail] = useState<PortfolioChainRail>('sui');
  const [tokens, setTokens] = useState<Awaited<ReturnType<typeof trpc.getEvmTokenBalances.query>>['tokens']>([]);
  const [evmLoading, setEvmLoading] = useState(false);
  const [nativeRows, setNativeRows] = useState<NativeRow[]>([]);
  const [nativeLoading, setNativeLoading] = useState(false);
  const [nativeErr, setNativeErr] = useState<string | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const explorerPrefs = useExplorerPreferences();
  const [portfolioEvmChainId, setPortfolioEvmChainId] = useState(() => networks?.active.evmChainId ?? 1);
  const [expandedSendKey, setExpandedSendKey] = useState<string | null>(null);
  const [btcWpkhRows, setBtcWpkhRows] = useState<NativeRow[]>([]);
  const [btcTrRows, setBtcTrRows] = useState<NativeRow[]>([]);
  const [btcLoading, setBtcLoading] = useState(false);
  const [btcErr, setBtcErr] = useState<string | null>(null);
  const [nameMap, setNameMap] = useState<Record<string, string>>({});
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  /** when list caps omit `chainAddresses`, hydrate from same on-chain derivation as background */
  const [hydratedAddrs, setHydratedAddrs] = useState<DwalletCapChainAddresses | null>(null);

  const chainId = networks?.active.evmChainId ?? 1;
  const evmNet = networks?.evm.find((n) => n.chainId === chainId);

  useEffect(() => {
    const id = networks?.active.evmChainId;
    if (id != null) setPortfolioEvmChainId(id);
  }, [networks?.active.evmChainId]);

  useEffect(() => {
    trpc.listOwnedDWalletCaps
      .query()
      .then(setCaps)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    trpc.dwalletAddressBook
      .query()
      .then(setBook)
      .catch(() => setBook(null));
  }, []);

  useEffect(() => {
    if (!balances || balances.locked) return;
    trpc.getDwalletDisplayNames
      .query()
      .then((r) => setNameMap(r.names))
      .catch(() => setNameMap({}));
  }, [balances]);

  const effectiveId = useMemo(() => {
    if (dwalletIdProp) return dwalletIdProp;
    const secp = book?.SECP256K1?.dwalletId;
    const ed = book?.ED25519?.dwalletId;
    if (secp) return secp;
    if (ed) return ed;
    const first = caps?.find(
      (c) => c.dwalletId !== 'unknown' && (c.curve === 'SECP256K1' || c.curve === 'ED25519'),
    );
    return first?.dwalletId;
  }, [dwalletIdProp, book, caps]);

  const cap = caps?.find((c) => c.dwalletId === effectiveId);

  const capWithAddrs = useMemo(() => {
    if (!cap) return undefined;
    const merged = { ...(hydratedAddrs ?? {}), ...(cap.chainAddresses ?? {}) } as DwalletCapChainAddresses;
    return { ...cap, chainAddresses: merged };
  }, [cap, hydratedAddrs]);

  useEffect(() => {
    if (!cap) return;
    if (cap.curve !== 'SECP256K1' && cap.curve !== 'ED25519') return;
    const c = cap.chainAddresses;
    const secpComplete =
      cap.curve === 'SECP256K1' &&
      Boolean(c?.evm?.trim() && c?.btcP2wpkh?.trim() && c?.btcP2tr?.trim());
    const edComplete =
      cap.curve === 'ED25519' &&
      Boolean(c?.sui?.trim() || c?.solana?.trim() || c?.aptos?.trim());
    if (secpComplete || edComplete) {
      setHydratedAddrs(null);
      return;
    }
    let cancelled = false;
    setHydratedAddrs(null);
    void trpc.getDwalletChainAddresses
      .query({ dwalletId: cap.dwalletId })
      .then((r) => {
        if (!cancelled && r.addresses && Object.keys(r.addresses).length) {
          setHydratedAddrs(r.addresses);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cap?.dwalletId, cap?.curve, cap?.chainAddresses]);

  const indexMap = useMemo(() => (caps ? buildDwalletIndexMap(caps) : new Map<string, number>()), [caps]);

  const resolvedWalletTitle = useMemo(() => {
    if (!cap || (cap.curve !== 'SECP256K1' && cap.curve !== 'ED25519')) {
      return 'dWallet';
    }
    return resolveDwalletLabel(cap.dwalletId, cap.curve as DwalletCurve, nameMap, indexMap);
  }, [cap, nameMap, indexMap]);

  useEffect(() => {
    if (!cap || editingName) return;
    const custom = nameMap[cap.dwalletId]?.trim() ?? '';
    setNameDraft(custom);
  }, [cap?.dwalletId, nameMap, cap, editingName]);

  const rails = useMemo(() => railsForCap(capWithAddrs), [capWithAddrs]);

  const secpCombined = Boolean(capWithAddrs?.curve === 'SECP256K1' && rails.includes('evm'));

  useEffect(() => {
    if (rails.length === 0) return;
    if (secpCombined) return;
    if (!rails.includes(rail)) {
      setRail(rails[0]!);
    }
  }, [rails, rail, secpCombined]);

  useEffect(() => {
    setExpandedSendKey(null);
  }, [portfolioEvmChainId]);

  const displayAddr = capWithAddrs ? addressForRail(capWithAddrs, rail) : undefined;
  const evmAddr = capWithAddrs?.chainAddresses?.evm;
  const evmDisplayChainId = secpCombined ? portfolioEvmChainId : chainId;
  const evmNetPortfolio = networks?.evm.find((n) => n.chainId === portfolioEvmChainId);

  const needsEvmTokens = secpCombined || rail === 'evm';

  useEffect(() => {
    if (!needsEvmTokens || typeof evmAddr !== 'string' || !evmAddr.trim()) {
      setTokens([]);
      setEvmLoading(false);
      return;
    }
    setEvmLoading(true);
    trpc.getEvmTokenBalances
      .query({ address: evmAddr.trim(), chainId: evmDisplayChainId })
      .then((r) => setTokens(r.tokens))
      .catch(() => setTokens([]))
      .finally(() => setEvmLoading(false));
  }, [needsEvmTokens, evmAddr, evmDisplayChainId]);

  useEffect(() => {
    if (!secpCombined || !capWithAddrs?.chainAddresses) {
      setBtcWpkhRows([]);
      setBtcTrRows([]);
      setBtcErr(null);
      setBtcLoading(false);
      return;
    }
    const wpkhAddr = capWithAddrs.chainAddresses.btcP2wpkh;
    const trAddr = capWithAddrs.chainAddresses.btcP2tr;
    if (!wpkhAddr && !trAddr) {
      setBtcWpkhRows([]);
      setBtcTrRows([]);
      setBtcLoading(false);
      return;
    }
    setBtcLoading(true);
    setBtcErr(null);
    Promise.all([
      typeof wpkhAddr === 'string' && wpkhAddr.trim()
        ? trpc.portfolioRailBalances.query({ rail: 'btcP2wpkh', address: wpkhAddr.trim() })
        : Promise.resolve([] as NativeRow[]),
      typeof trAddr === 'string' && trAddr.trim()
        ? trpc.portfolioRailBalances.query({ rail: 'btcP2tr', address: trAddr.trim() })
        : Promise.resolve([] as NativeRow[]),
    ])
      .then(([a, b]) => {
        setBtcWpkhRows(a);
        setBtcTrRows(b);
      })
      .catch((e) => {
        setBtcWpkhRows([]);
        setBtcTrRows([]);
        setBtcErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBtcLoading(false));
  }, [secpCombined, capWithAddrs?.chainAddresses?.btcP2wpkh, capWithAddrs?.chainAddresses?.btcP2tr]);

  const secpNativeRows: NativeAssetRow[] = useMemo(
    () => [...mapBtcPortfolioRows(btcWpkhRows, 'btcP2wpkh'), ...mapBtcPortfolioRows(btcTrRows, 'btcP2tr')],
    [btcWpkhRows, btcTrRows],
  );

  const portfolioRail = useMemo(() => railToPortfolioInput(rail), [rail]);

  useEffect(() => {
    if (secpCombined) {
      setNativeRows([]);
      setNativeErr(null);
      setNativeLoading(false);
      return;
    }
    if (
      rail === 'evm' ||
      !portfolioRail ||
      typeof displayAddr !== 'string' ||
      !displayAddr.trim()
    ) {
      setNativeRows([]);
      setNativeErr(null);
      setNativeLoading(false);
      return;
    }
    setNativeLoading(true);
    setNativeErr(null);
    trpc.portfolioRailBalances
      .query({ rail: portfolioRail, address: displayAddr.trim() })
      .then((rows) => {
        setNativeRows(rows);
      })
      .catch((e) => {
        setNativeRows([]);
        setNativeErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setNativeLoading(false));
  }, [secpCombined, rail, displayAddr, portfolioRail]);

  const evmUsdTotal = useMemo(() => tokens.reduce((s, t) => s + (t.usdValue ?? 0), 0), [tokens]);

  const nativeUsdTotal = useMemo(
    () => nativeRows.reduce((s, r) => s + (r.usdValue ?? 0), 0),
    [nativeRows],
  );

  const btcUsdTotal = useMemo(
    () =>
      [...btcWpkhRows, ...btcTrRows].reduce((s, r) => s + (r.usdValue ?? 0), 0),
    [btcWpkhRows, btcTrRows],
  );

  const combinedSecpUsd = useMemo(() => btcUsdTotal + evmUsdTotal, [btcUsdTotal, evmUsdTotal]);

  const displayAddrExplorerHref = useMemo(() => {
    if (!networks || !displayAddr?.trim()) return null;
    const a = displayAddr.trim();
    if (rail === 'evm') return evmAddressExplorerUrl(evmNet?.explorerUrl, a);
    if (rail === 'sui')
      return buildSuiExplorerUrl(explorerPrefs, networks.active.suiNetworkId, 'address', a);
    if (rail === 'solana')
      return buildSolanaExplorerUrl(explorerPrefs, networks.active.solNetworkId, 'address', a);
    if (rail === 'aptos') return aptosAccountExplorerUrl(networks, a);
    if (rail === 'btcP2wpkh' || rail === 'btcP2tr') return btcAddressExplorerUrl(networks, a);
    return null;
  }, [networks, displayAddr, rail, evmNet, explorerPrefs]);

  const secpEvmHref = useMemo(() => {
    if (!networks || !capWithAddrs?.chainAddresses?.evm?.trim()) return null;
    const net = networks.evm.find((n) => n.chainId === networks.active.evmChainId);
    return evmAddressExplorerUrl(net?.explorerUrl, capWithAddrs.chainAddresses.evm.trim());
  }, [networks, capWithAddrs?.chainAddresses?.evm]);

  const secpBtcWpkhHref = useMemo(
    () =>
      capWithAddrs?.chainAddresses?.btcP2wpkh?.trim()
        ? btcAddressExplorerUrl(networks, capWithAddrs.chainAddresses.btcP2wpkh.trim())
        : null,
    [networks, capWithAddrs?.chainAddresses?.btcP2wpkh],
  );

  const secpBtcTrHref = useMemo(
    () =>
      capWithAddrs?.chainAddresses?.btcP2tr?.trim()
        ? btcAddressExplorerUrl(networks, capWithAddrs.chainAddresses.btcP2tr.trim())
        : null,
    [networks, capWithAddrs?.chainAddresses?.btcP2tr],
  );

  async function saveDisplayName() {
    if (!cap) return;
    setNameSaving(true);
    try {
      await trpc.setDwalletDisplayName.mutate({ dwalletId: cap.dwalletId, name: nameDraft });
      const r = await trpc.getDwalletDisplayNames.query();
      setNameMap(r.names);
      setEditingName(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setNameSaving(false);
    }
  }

  const evmNetworkHeader = (evmNetPortfolio?.name ?? 'Ethereum').toUpperCase();

  const receiveAddr = secpCombined
    ? (evmAddr ?? capWithAddrs?.chainAddresses?.btcP2wpkh ?? capWithAddrs?.chainAddresses?.btcP2tr ?? '')
    : (displayAddr ?? '');

  const receiveExplorerHref = useMemo(() => {
    if (!networks || !receiveAddr.trim()) return null;
    const a = receiveAddr.trim();
    if (secpCombined) {
      if (a.startsWith('0x') && a.length === 42) {
        const net = networks.evm.find((n) => n.chainId === networks.active.evmChainId);
        return evmAddressExplorerUrl(net?.explorerUrl, a);
      }
      return btcAddressExplorerUrl(networks, a);
    }
    if (rail === 'evm') return evmAddressExplorerUrl(evmNet?.explorerUrl, a);
    if (rail === 'sui') return buildSuiExplorerUrl(explorerPrefs, networks.active.suiNetworkId, 'address', a);
    if (rail === 'solana') return buildSolanaExplorerUrl(explorerPrefs, networks.active.solNetworkId, 'address', a);
    if (rail === 'aptos') return aptosAccountExplorerUrl(networks, a);
    if (rail === 'btcP2wpkh' || rail === 'btcP2tr') return btcAddressExplorerUrl(networks, a);
    return null;
  }, [networks, receiveAddr, secpCombined, rail, evmNet, explorerPrefs]);

  const inlineSendConfig =
    secpCombined && networks
      ? {
          evmChainId: portfolioEvmChainId,
          evmExplorerBaseUrl: evmNetPortfolio?.explorerUrl,
          evmNativeDecimals: evmNetPortfolio?.decimals ?? 18,
          evmNativeSymbol: evmNetPortfolio?.symbol ?? 'ETH',
          expandedKey: expandedSendKey,
          onToggleSend: (key: string) => {
            setExpandedSendKey((prev) => (prev === key ? null : key));
          },
          onSent: () => {
            if (typeof evmAddr !== 'string' || !evmAddr.trim()) return;
            void trpc.getEvmTokenBalances
              .query({ address: evmAddr.trim(), chainId: portfolioEvmChainId })
              .then((r) => setTokens(r.tokens))
              .catch(() => {});
          },
          onOpenSend,
        }
      : undefined;

  const canRename =
    cap && (cap.curve === 'SECP256K1' || cap.curve === 'ED25519') ? cap.dwalletId : null;

  // ---------------- pcToken integration (Solana rail) ----------------

  const isSolanaRail = !secpCombined && rail === 'solana';
  const [pcMarkets, setPcMarkets] = useState<PcMarket[]>([]);
  const [pcMarketsLoading, setPcMarketsLoading] = useState(false);
  const [pcBalances, setPcBalances] = useState<Record<string, string>>({});
  const [pcDecrypting, setPcDecrypting] = useState<Record<string, boolean>>({});
  const [solanaSplRows, setSolanaSplRows] = useState<SolanaSplRow[]>([]);
  const [solanaSplLoading, setSolanaSplLoading] = useState(false);
  const [wrapModal, setWrapModal] = useState<
    | { marketId: string; marketLabel: string; splSymbol: string; splDecimals: number }
    | null
  >(null);
  const [unwrapModal, setUnwrapModal] = useState<
    | { marketId: string; marketLabel: string; splSymbol: string; splDecimals: number }
    | null
  >(null);

  const refreshPcMarkets = useCallback(async () => {
    setPcMarketsLoading(true);
    try {
      const r = await trpc.listPcTokenMarkets.query();
      setPcMarkets(r.markets);
    } catch {
      setPcMarkets([]);
    } finally {
      setPcMarketsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isSolanaRail) {
      setPcMarkets([]);
      setPcBalances({});
      setSolanaSplRows([]);
      return;
    }
    void refreshPcMarkets();
  }, [isSolanaRail, refreshPcMarkets]);

  // SPL holdings at the **dWallet's** Solana address (not the vault fee-payer). on devnet/testnet
  // these typically have no token-list / metadata entry, so we render them as "unknown assets":
  // mint-prefix as the symbol, full mint shown next to it, no USD. without this the portfolio
  // looked empty for users whose only Solana holdings were random devnet mints.
  useEffect(() => {
    if (!isSolanaRail) return;
    if (typeof displayAddr !== 'string' || !displayAddr.trim()) {
      setSolanaSplRows([]);
      return;
    }
    let cancelled = false;
    setSolanaSplLoading(true);
    const dwalletSolanaAddr = displayAddr.trim();
    void trpc.listSolanaSplBalancesForDwallet
      .query({ address: dwalletSolanaAddr })
      .then((r) => {
        if (cancelled) return;
        setSolanaSplRows(
          r.tokens.map(
            (t): SolanaSplRow => ({
              rowKey: `spl:${t.mint}`,
              mint: t.mint,
              symbol: t.mint.slice(0, 4),
              balanceFormatted: t.balance,
              balanceRaw: t.balanceRaw,
              decimals: t.decimals,
              eligibleMarketIds: pcMarkets.filter((m) => m.splMint === t.mint).map((m) => m.id),
            }),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setSolanaSplRows([]);
      })
      .finally(() => {
        if (!cancelled) setSolanaSplLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSolanaRail, pcMarkets, displayAddr]);

  const decryptPcBalance = useCallback(
    async (marketId: string) => {
      setPcDecrypting((p) => ({ ...p, [marketId]: true }));
      try {
        const r = await trpc.getPcBalance.query({ marketId });
        setPcBalances((p) => ({ ...p, [marketId]: r.balanceBaseUnits }));
      } catch {
        // leave existing balance; UI shows last known
      } finally {
        setPcDecrypting((p) => ({ ...p, [marketId]: false }));
      }
    },
    [],
  );

  const pcTokenRows = useMemo<PcTokenAssetRow[]>(() => {
    if (!isSolanaRail) return [];
    return pcMarkets.map((m): PcTokenAssetRow => {
      const baseUnits = pcBalances[m.id] ?? null;
      const isZero = baseUnits === null || baseUnits === '0';
      return {
        rowKey: `pc:${m.id}`,
        marketId: m.id,
        marketLabel: m.label,
        splSymbol: m.splSymbol,
        splDecimals: m.splDecimals,
        balanceBaseUnits: baseUnits,
        isZero,
      };
    });
  }, [isSolanaRail, pcMarkets, pcBalances]);

  const pcTokenConfig: PortfolioPcTokenConfig | undefined = isSolanaRail
    ? {
        onWrap: ({ marketId }) => {
          const market = pcMarkets.find((m) => m.id === marketId);
          if (!market) return;
          setWrapModal({
            marketId: market.id,
            marketLabel: market.label,
            splSymbol: market.splSymbol,
            splDecimals: market.splDecimals,
          });
        },
        onSendPcToken: (marketId) => {
          onOpenSend?.({ pcMarketId: marketId });
        },
        onUnwrap: (marketId) => {
          const market = pcMarkets.find((m) => m.id === marketId);
          if (!market) return;
          setUnwrapModal({
            marketId: market.id,
            marketLabel: market.label,
            splSymbol: market.splSymbol,
            splDecimals: market.splDecimals,
          });
        },
        onDecrypt: (marketId) => void decryptPcBalance(marketId),
        decrypting: pcDecrypting,
      }
    : undefined;

  void pcMarketsLoading; // reserved for a future "loading markets…" indicator
  void solanaSplLoading;

  return (
    <div className="sp-page cp-portfolio dp-portfolio sp-page--dwalletHome">
      <ReceiveAddressSheet
        open={receiveOpen && Boolean(receiveAddr)}
        onClose={() => setReceiveOpen(false)}
        address={receiveAddr}
        explorerHref={receiveExplorerHref}
        label={secpCombined ? (evmAddr ? 'Ethereum (primary)' : 'Bitcoin') : RAIL_LABEL[rail]}
      />
      {onBack ? (
        <div className="cp-portfolioHead" style={{ paddingInline: 'var(--ch-content-pad, 14px)' }}>
          <button type="button" className="sp-backBtn" onClick={onBack}>
            ← back
          </button>
        </div>
      ) : null}
      {err && (
        <div className="sp-error" style={{ paddingInline: 'var(--ch-content-pad, 14px)' }}>
          {err}
        </div>
      )}
      {caps === null && !err && (
        <div className="sp-muted" style={{ paddingInline: 'var(--ch-content-pad, 14px)' }}>
          loading…
        </div>
      )}
      {caps !== null && !cap && !err && (
        <div className="dp-dwalletEmpty" role="status" aria-live="polite">
          <SadWalletGlyph />
          <p className="dp-dwalletEmpty-title">No dWallets in this vault yet</p>
          <p className="dp-dwalletEmpty-text">
            Head over to the Vault tab to create your first dWallet — that's the identity you'll use for sends and dapps.
          </p>
        </div>
      )}
      {cap && rails.length === 0 && (
        <p className="sp-muted" style={{ fontSize: 12, marginTop: 8, paddingInline: 'var(--ch-content-pad, 14px)' }}>
          addresses not ready yet — complete zero-trust or wait for sync.
        </p>
      )}
      {cap && rails.length > 0 && (
        <>
          <div className="dp-dwalletSummaryHero">
            <div className="dp-dwalletSummaryTitleRow">
              <h1 className="dp-dwalletSummaryTitle">{resolvedWalletTitle}</h1>
              {canRename ? (
                <button
                  type="button"
                  className="dp-dwalletRenameBtn"
                  aria-label={editingName ? 'close rename' : 'rename wallet'}
                  onClick={() => {
                    const custom = nameMap[cap.dwalletId]?.trim() ?? '';
                    if (editingName) {
                      setEditingName(false);
                      setNameDraft(custom);
                    } else {
                      setNameDraft(custom);
                      setEditingName(true);
                    }
                  }}
                >
                  <Pencil size={16} strokeWidth={2} />
                </button>
              ) : null}
            </div>
            {editingName && canRename ? (
              <div className="dp-dwalletRenameField">
                <input
                  type="text"
                  className="sp-input"
                  value={nameDraft}
                  maxLength={64}
                  placeholder="custom name"
                  onChange={(e) => setNameDraft(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    className="sp-btn sp-btnPrimary"
                    style={{ flex: 1 }}
                    disabled={nameSaving}
                    onClick={() => void saveDisplayName()}
                  >
                    {nameSaving ? 'saving…' : 'save'}
                  </button>
                  <button
                    type="button"
                    className="sp-btn"
                    disabled={nameSaving}
                    onClick={() => {
                      setEditingName(false);
                      setNameDraft(nameMap[cap.dwalletId]?.trim() ?? '');
                    }}
                  >
                    cancel
                  </button>
                </div>
              </div>
            ) : null}
            <p className="sp-muted" style={{ fontSize: 11, margin: '4px 0 10px', lineHeight: 1.45 }}>
              {cap.curve === 'SECP256K1'
                ? '[BTC · EVM] dWallet'
                : cap.curve === 'ED25519'
                  ? '[SOL · SUI · APT] dWallet'
                  : 'dWallet'}{' '}
              · tail {dwalletTailHex(cap.dwalletId)}
            </p>
            <div className="dp-capIdRows" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
              <div className="cp-portfolioAddrRow" style={{ alignItems: 'center' }}>
                <span className="sp-muted" style={{ fontSize: 10, flexShrink: 0 }}>
                  dWallet cap
                </span>
                <ExplorerValueRow
                  fullValue={cap.capObjectId}
                  href={capObjectExplorerHref(explorerPrefs, networks, cap.capObjectId)}
                  truncateMid={{ head: 10, tail: 8 }}
                  copyLabel="copy dWallet cap id"
                  linkClassName="cd-explorerMonoLink mono"
                />
              </div>
              <div className="cp-portfolioAddrRow" style={{ alignItems: 'center' }}>
                <span className="sp-muted" style={{ fontSize: 10, flexShrink: 0 }}>
                  dWallet id
                </span>
                <ExplorerValueRow
                  fullValue={cap.dwalletId}
                  href={dwalletObjectExplorerHref(explorerPrefs, networks, cap.dwalletId)}
                  truncateMid={{ head: 10, tail: 8 }}
                  copyLabel="copy dWallet object id"
                  linkClassName="cd-explorerMonoLink mono"
                />
              </div>
            </div>
            {secpCombined ? (
              <div className="dp-secpAddrStack">
                {capWithAddrs?.chainAddresses?.evm ? (
                  <div className="cp-portfolioAddrRow" style={{ alignItems: 'center' }}>
                    <span className="sp-muted" style={{ fontSize: 10, flexShrink: 0 }}>
                      ethereum
                    </span>
                    <ExplorerValueRow
                      fullValue={capWithAddrs.chainAddresses.evm}
                      href={secpEvmHref}
                      truncateMid={{ head: 10, tail: 8 }}
                      copyLabel="copy ethereum address"
                      linkClassName="cd-explorerMonoLink mono"
                    />
                  </div>
                ) : null}
                {capWithAddrs?.chainAddresses?.btcP2wpkh ? (
                  <div className="cp-portfolioAddrRow" style={{ alignItems: 'center' }}>
                    <span className="sp-muted" style={{ fontSize: 10, flexShrink: 0 }}>
                      btc segwit
                    </span>
                    <ExplorerValueRow
                      fullValue={capWithAddrs.chainAddresses.btcP2wpkh}
                      href={secpBtcWpkhHref}
                      truncateMid={{ head: 10, tail: 8 }}
                      copyLabel="copy segwit address"
                      linkClassName="cd-explorerMonoLink mono"
                    />
                  </div>
                ) : null}
                {capWithAddrs?.chainAddresses?.btcP2tr ? (
                  <div className="cp-portfolioAddrRow" style={{ alignItems: 'center' }}>
                    <span className="sp-muted" style={{ fontSize: 10, flexShrink: 0 }}>
                      btc taproot
                    </span>
                    <ExplorerValueRow
                      fullValue={capWithAddrs.chainAddresses.btcP2tr}
                      href={secpBtcTrHref}
                      truncateMid={{ head: 10, tail: 8 }}
                      copyLabel="copy taproot address"
                      linkClassName="cd-explorerMonoLink mono"
                    />
                  </div>
                ) : null}
              </div>
            ) : displayAddr ? (
              <div className="cp-portfolioAddrRow" style={{ alignItems: 'center' }}>
                <ExplorerValueRow
                  fullValue={displayAddr}
                  href={displayAddrExplorerHref}
                  truncateMid={{ head: 10, tail: 8 }}
                  copyLabel="copy address"
                  linkClassName="cd-explorerMonoLink mono"
                />
              </div>
            ) : null}
            <div className="dp-actionsRow">
              <button type="button" className="sp-btn sp-btnPrimary" style={{ flex: 1 }} onClick={() => onOpenSend?.()}>
                <span className="dp-actIcon" aria-hidden>
                  <ArrowUpRight size={18} strokeWidth={2} />
                </span>
                send
              </button>
              <button
                type="button"
                className="sp-btn"
                style={{ flex: 1 }}
                disabled={!receiveAddr}
                onClick={() => setReceiveOpen(true)}
              >
                <span className="dp-actIcon" aria-hidden>
                  <ArrowDownLeft size={18} strokeWidth={2} />
                </span>
                receive
              </button>
            </div>
            <div className="cp-totalUsd">
              {secpCombined
                ? btcLoading && evmLoading && combinedSecpUsd === 0
                  ? '…'
                  : btcErr && combinedSecpUsd === 0
                    ? '—'
                    : formatUsd(combinedSecpUsd)
                : rail === 'evm'
                  ? evmLoading && evmUsdTotal === 0
                    ? '…'
                    : formatUsd(evmUsdTotal)
                  : nativeLoading
                    ? '…'
                    : nativeErr
                      ? '—'
                      : nativeRows.length > 0
                        ? formatUsd(nativeUsdTotal)
                        : '—'}
            </div>
          </div>

          <div className="dp-portfolioAssetsSlab">
            {!secpCombined ? (
              <div className="dp-chipRow" role="tablist" aria-label="chain" style={{ marginBottom: 10 }}>
                {rails.map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="tab"
                    className={`sp-chip${rail === r ? ' sp-chipActive' : ''}`}
                    onClick={() => setRail(r)}
                  >
                    {RAIL_LABEL[r]}
                  </button>
                ))}
              </div>
            ) : null}

            {secpCombined && networks ? (
              <div className="cp-portfolioSecpAssetStack">
                <div className="cp-portfolioSectionHdr">BITCOIN:</div>
                <PortfolioAssetTable
                  nativeRows={secpNativeRows}
                  loading={btcLoading}
                  error={btcErr}
                  emptyHint="no bitcoin balance data yet."
                  inlineSend={inlineSendConfig}
                  hideSendWhenZeroBalance
                />
                <div className="cp-portfolioSecpRule" aria-hidden />
                <div className="cp-portfolioEvmHdrRow">
                  <span className="cp-portfolioEvmHdrLabel">{evmNetworkHeader}:</span>
                  {evmAddr ? (
                    <select
                      className="cp-portfolioNetSelect"
                      value={portfolioEvmChainId}
                      onChange={(e) => setPortfolioEvmChainId(Number(e.target.value))}
                      aria-label="evm network for balances and send"
                    >
                      {networks.evm.map((n) => (
                        <option key={n.chainId} value={n.chainId}>
                          {n.name} · {n.symbol}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="sp-muted" style={{ fontSize: 10 }}>
                      evm pending
                    </span>
                  )}
                </div>
                {!evmAddr ? (
                  <p className="sp-muted" style={{ fontSize: 11, marginBottom: 8 }}>
                    evm address not ready yet — token list appears when sync completes.
                  </p>
                ) : null}
                <PortfolioAssetTable
                  evmTokens={evmAddr ? tokens : []}
                  loading={evmLoading}
                  error={null}
                  emptyHint="no balance on this network yet."
                  inlineSend={inlineSendConfig}
                  hideSendWhenZeroBalance
                />
              </div>
            ) : null}
            {!secpCombined && rail === 'evm' && displayAddr ? (
              <PortfolioAssetTable evmTokens={tokens} emptyHint="no balance data for this chain yet." />
            ) : null}
            {!secpCombined && rail !== 'evm' && displayAddr ? (
              <PortfolioAssetTable
                nativeRows={nativeRows}
                splRows={isSolanaRail ? solanaSplRows : undefined}
                pcTokenRows={isSolanaRail ? pcTokenRows : undefined}
                pcTokenConfig={pcTokenConfig}
                loading={nativeLoading}
                error={nativeErr}
                emptyHint="no balance data for this chain yet."
              />
            ) : null}
          </div>
        </>
      )}
      {wrapModal && (
        <WrapPcTokenModal
          marketId={wrapModal.marketId}
          marketLabel={wrapModal.marketLabel}
          splSymbol={wrapModal.splSymbol}
          splDecimals={wrapModal.splDecimals}
          onClose={() => setWrapModal(null)}
          onSuccess={() => {
            void decryptPcBalance(wrapModal.marketId);
          }}
        />
      )}
      {unwrapModal && (
        <UnwrapPcTokenModal
          marketId={unwrapModal.marketId}
          marketLabel={unwrapModal.marketLabel}
          splSymbol={unwrapModal.splSymbol}
          splDecimals={unwrapModal.splDecimals}
          onClose={() => setUnwrapModal(null)}
          onSuccess={() => {
            void decryptPcBalance(unwrapModal.marketId);
          }}
        />
      )}
    </div>
  );
}
