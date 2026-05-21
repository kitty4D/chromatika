import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/background/services/price', () => ({
  getPrice: vi.fn(async (symbol: string) => {
    const prices: Record<string, number> = { BTC: 105_000, ETH: 3_200, SOL: 180 };
    return prices[symbol] ?? 0;
  }),
}));

vi.mock('./notify-prefs', () => ({
  getPriceAlerts: vi.fn(),
  markPriceAlertFired: vi.fn(),
}));

vi.mock('./notify-chrome', () => ({
  maybeFireNotification: vi.fn(async () => true),
}));

import { checkPriceAlerts } from './price-alert-checker';
import { getPriceAlerts, markPriceAlertFired } from './notify-prefs';
import { maybeFireNotification } from './notify-chrome';

beforeEach(() => vi.clearAllMocks());

describe('checkPriceAlerts', () => {
  it('fires notification when above threshold is crossed', async () => {
    vi.mocked(getPriceAlerts).mockResolvedValue({
      alerts: [
        {
          id: 'a1',
          symbol: 'BTC',
          direction: 'above',
          thresholdUsd: 100_000,
          createdAtMs: 1,
        },
      ],
    });
    await checkPriceAlerts();
    expect(maybeFireNotification).toHaveBeenCalledOnce();
    expect(markPriceAlertFired).toHaveBeenCalledWith('a1');
  });

  it('does not fire when threshold is not crossed', async () => {
    vi.mocked(getPriceAlerts).mockResolvedValue({
      alerts: [
        {
          id: 'a2',
          symbol: 'BTC',
          direction: 'above',
          thresholdUsd: 200_000,
          createdAtMs: 1,
        },
      ],
    });
    await checkPriceAlerts();
    expect(maybeFireNotification).not.toHaveBeenCalled();
  });

  it('skips already-fired alerts', async () => {
    vi.mocked(getPriceAlerts).mockResolvedValue({
      alerts: [
        {
          id: 'a3',
          symbol: 'BTC',
          direction: 'above',
          thresholdUsd: 100_000,
          createdAtMs: 1,
          firedAtMs: 999,
        },
      ],
    });
    await checkPriceAlerts();
    expect(maybeFireNotification).not.toHaveBeenCalled();
  });

  it('fires for below threshold', async () => {
    vi.mocked(getPriceAlerts).mockResolvedValue({
      alerts: [
        {
          id: 'a4',
          symbol: 'SOL',
          direction: 'below',
          thresholdUsd: 200,
          createdAtMs: 1,
        },
      ],
    });
    await checkPriceAlerts();
    expect(maybeFireNotification).toHaveBeenCalledOnce();
  });

  it('does not fire below alert when price is higher', async () => {
    vi.mocked(getPriceAlerts).mockResolvedValue({
      alerts: [
        {
          id: 'a5',
          symbol: 'ETH',
          direction: 'below',
          thresholdUsd: 2_000,
          createdAtMs: 1,
        },
      ],
    });
    await checkPriceAlerts();
    // ETH mock price is 3200, which is above 2000 threshold
    expect(maybeFireNotification).not.toHaveBeenCalled();
  });

  it('handles empty alerts gracefully', async () => {
    vi.mocked(getPriceAlerts).mockResolvedValue({ alerts: [] });
    await checkPriceAlerts();
    expect(maybeFireNotification).not.toHaveBeenCalled();
  });
});
