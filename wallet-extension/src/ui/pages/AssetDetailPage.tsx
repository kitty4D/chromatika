import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { formatUsd } from '@/lib/sui-amount';
import { TokenIcon } from '@/ui/components/TokenIcon';
import { PriceChart, type ChartPoint } from '@/ui/components/PriceChart';
import { MarketDataPanel } from '@/ui/components/MarketDataPanel';
import { useBalancePrivacy, BALANCE_MASK } from '@/lib/use-balance-privacy';
import type { MarketData } from '@/background/services/market-data';

export type AssetDetailRow = {
  key: string;
  symbol: string;
  name: string;
  balanceFormatted: string;
  usdValue: number | null;
  pricePerTokenUsd: number | null;
  changePercent24h: number | null;
  iconUrl?: string | null;
  chainLogoUrl?: string | null;
};

const CHART_PERIODS = [
  { label: '1D', days: 1 },
  { label: '1W', days: 7 },
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '1Y', days: 365 },
] as const;

export function AssetDetailPage({
  row,
  onBack,
  onSend,
  onReceive,
}: {
  row: AssetDetailRow;
  onBack: () => void;
  onSend?: () => void;
  onReceive?: () => void;
}) {
  const { hidden: balanceHidden } = useBalancePrivacy();
  const [chartPoints, setChartPoints] = useState<ChartPoint[]>([]);
  const [chartLoading, setChartLoading] = useState(true);
  const [chartDays, setChartDays] = useState(7);
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [marketLoading, setMarketLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setChartLoading(true);
    trpc.getChartData
      .query({ symbol: row.symbol, days: chartDays })
      .then((pts) => {
        if (!cancelled) setChartPoints(pts);
      })
      .catch(() => {
        if (!cancelled) setChartPoints([]);
      })
      .finally(() => {
        if (!cancelled) setChartLoading(false);
      });
    return () => { cancelled = true; };
  }, [row.symbol, chartDays]);

  useEffect(() => {
    let cancelled = false;
    setMarketLoading(true);
    trpc.getMarketData
      .query({ symbol: row.symbol })
      .then((d) => {
        if (!cancelled) setMarketData(d);
      })
      .catch(() => {
        if (!cancelled) setMarketData(null);
      })
      .finally(() => {
        if (!cancelled) setMarketLoading(false);
      });
    return () => { cancelled = true; };
  }, [row.symbol]);

  const changeUp = (row.changePercent24h ?? 0) >= 0;
  const changeText = useMemo(() => {
    if (row.changePercent24h == null) return '--';
    const sign = row.changePercent24h >= 0 ? '+' : '';
    return `${sign}${row.changePercent24h.toFixed(2)}%`;
  }, [row.changePercent24h]);

  const changeColor = changeUp ? '#22c55e' : '#ef4444';

  const handlePeriodChange = useCallback((days: number) => {
    setChartDays(days);
  }, []);

  return (
    <div className="sp-page cp-assetDetail">
      <div style={{ paddingInline: 'var(--ch-content-pad, 14px)' }}>
        <button type="button" className="sp-backBtn" onClick={onBack}>
          ← back
        </button>
      </div>

      {/* header */}
      <div className="cp-assetDetail-header">
        <TokenIcon iconUrl={row.iconUrl} symbol={row.symbol} chainLogoUrl={row.chainLogoUrl} size={32} />
        <div className="cp-assetDetail-headerText">
          <div className="cp-assetDetail-symbol">{row.symbol}</div>
          <div className="cp-assetDetail-name">{row.name}</div>
        </div>
        {row.pricePerTokenUsd != null ? (
          <div className="cp-assetDetail-price">{formatUsd(row.pricePerTokenUsd)}</div>
        ) : null}
      </div>

      {/* balance */}
      <div className="cp-assetDetail-balance">
        <div className="cp-assetDetail-balAmount">
          {balanceHidden ? BALANCE_MASK : row.balanceFormatted} {!balanceHidden && row.symbol}
        </div>
        <div className="cp-assetDetail-balUsd">
          {balanceHidden ? BALANCE_MASK : row.usdValue != null ? formatUsd(row.usdValue) : '-'}
        </div>
      </div>

      {/* 24h change */}
      <div className="cp-assetDetail-change" style={{ color: row.changePercent24h != null ? changeColor : undefined }}>
        {balanceHidden ? BALANCE_MASK : changeText}
        {!balanceHidden && row.changePercent24h != null && row.usdValue != null ? (
          <span className="cp-assetDetail-changeDelta">
            {' '}({formatUsd(Math.abs(row.usdValue * (row.changePercent24h / 100)))})
          </span>
        ) : null}
      </div>

      {/* actions */}
      <div className="dp-actionsRow" style={{ marginTop: 12, marginBottom: 14 }}>
        {onSend ? (
          <button type="button" className="sp-btn sp-btnPrimary" style={{ flex: 1 }} onClick={onSend}>
            <span className="dp-actIcon" aria-hidden><ArrowUpRight size={18} strokeWidth={2} /></span>
            send
          </button>
        ) : null}
        {onReceive ? (
          <button type="button" className="sp-btn" style={{ flex: 1 }} onClick={onReceive}>
            <span className="dp-actIcon" aria-hidden><ArrowDownLeft size={18} strokeWidth={2} /></span>
            receive
          </button>
        ) : null}
      </div>

      {/* chart */}
      <div className="cp-assetDetail-section">
        <div className="cp-assetDetail-sectionTitle">price</div>
        {chartLoading ? (
          <div className="sp-muted" style={{ fontSize: 11, height: 140, display: 'flex', alignItems: 'center' }}>loading chart...</div>
        ) : (
          <PriceChart points={chartPoints} up={changeUp} />
        )}
        <div className="cp-chartPeriodRow">
          {CHART_PERIODS.map((p) => (
            <button
              key={p.days}
              type="button"
              className={`sp-chip${chartDays === p.days ? ' sp-chipActive' : ''}`}
              onClick={() => handlePeriodChange(p.days)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* market data */}
      <div className="cp-assetDetail-section">
        <div className="cp-assetDetail-sectionTitle">market data</div>
        {marketLoading ? (
          <div className="sp-muted" style={{ fontSize: 11 }}>loading...</div>
        ) : (
          <MarketDataPanel data={marketData} />
        )}
      </div>
    </div>
  );
}
