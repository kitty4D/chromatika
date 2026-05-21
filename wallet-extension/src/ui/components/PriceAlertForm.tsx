import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import type { PriceAlert, PriceAlertDirection } from '@/background/services/notifications/types';

export function PriceAlertForm({
  onCreated,
  onCancel,
}: {
  onCreated: (alert: PriceAlert) => void;
  onCancel: () => void;
}) {
  const [symbol, setSymbol] = useState('BTC');
  const [direction, setDirection] = useState<PriceAlertDirection>('above');
  const [threshold, setThreshold] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    const usd = parseFloat(threshold);
    if (!usd || usd <= 0) {
      setError('enter a valid price');
      return;
    }
    try {
      const alert = await trpc.addPriceAlert.mutate({
        symbol,
        direction,
        thresholdUsd: usd,
      });
      onCreated(alert);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    }
  };

  return (
    <div style={{ marginTop: 8, padding: 12, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <select
          className="sp-input"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          style={{ flex: 1 }}
        >
          {['BTC', 'ETH', 'SOL', 'SUI', 'APT', 'IKA', 'BNB', 'AVAX'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className="sp-input"
          value={direction}
          onChange={(e) => setDirection(e.target.value as PriceAlertDirection)}
        >
          <option value="above">above</option>
          <option value="below">below</option>
        </select>
      </div>
      <input
        type="number"
        placeholder="price (USD)"
        value={threshold}
        onChange={(e) => {
          setThreshold(e.target.value);
          setError('');
        }}
        className="sp-input"
        style={{ width: '100%', marginBottom: 8 }}
      />
      {error && <div className="sp-error" style={{ fontSize: 11, marginBottom: 6 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="sp-btn" onClick={submit}>
          create
        </button>
        <button type="button" className="sp-btn" onClick={onCancel}>
          cancel
        </button>
      </div>
    </div>
  );
}
