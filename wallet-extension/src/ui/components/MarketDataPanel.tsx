import type { MarketData } from '@/background/services/market-data';

function compactNumber(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function DataRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="cp-marketRow">
      <span className="cp-marketRowLabel">{label}</span>
      <span className="cp-marketRowValue">{value ?? '-'}</span>
    </div>
  );
}

export function MarketDataPanel({ data }: { data: MarketData | null }) {
  if (!data) {
    return <p className="sp-muted" style={{ fontSize: 11 }}>no market data available</p>;
  }
  const capStr = data.marketCap != null
    ? `$${compactNumber(data.marketCap)}${data.marketCapRank != null ? ` #${data.marketCapRank}` : ''}`
    : null;
  const circStr = data.circulatingSupply != null ? compactNumber(data.circulatingSupply) : null;
  const totalStr = data.totalSupply != null ? compactNumber(data.totalSupply) : null;

  return (
    <div className="cp-marketGrid">
      <DataRow label="market cap" value={capStr} />
      <DataRow label="circulating supply" value={circStr} />
      <DataRow label="total supply" value={totalStr} />
      {data.contractAddress ? (
        <DataRow label={data.chain ?? 'contract'} value={data.contractAddress.length > 16 ? `${data.contractAddress.slice(0, 8)}...${data.contractAddress.slice(-6)}` : data.contractAddress} />
      ) : null}
    </div>
  );
}
