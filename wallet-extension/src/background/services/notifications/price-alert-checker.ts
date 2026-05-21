import { getPrice } from '@/background/services/price';
import { getPriceAlerts, markPriceAlertFired } from './notify-prefs';
import { maybeFireNotification } from './notify-chrome';
import type { PriceAlert } from './types';

function isThresholdCrossed(alert: PriceAlert, currentPrice: number): boolean {
  if (alert.direction === 'above') return currentPrice >= alert.thresholdUsd;
  return currentPrice <= alert.thresholdUsd;
}

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

export async function checkPriceAlerts(): Promise<void> {
  const { alerts } = await getPriceAlerts();
  const unfired = alerts.filter((a) => !a.firedAtMs);
  if (unfired.length === 0) return;

  const symbols = [...new Set(unfired.map((a) => a.symbol))];
  const prices = new Map<string, number>();

  for (const sym of symbols) {
    try {
      prices.set(sym, await getPrice(sym));
    } catch {
      // price unavailable, skip alerts for this symbol
    }
  }

  for (const alert of unfired) {
    const price = prices.get(alert.symbol);
    if (price === undefined) continue;

    if (isThresholdCrossed(alert, price)) {
      const dir = alert.direction === 'above' ? 'above' : 'below';
      await maybeFireNotification('priceAlerts', {
        id: `chromatika-price-${alert.id}`,
        title: `${alert.symbol} ${dir} ${formatUsd(alert.thresholdUsd)}`,
        message: `${alert.symbol} is now ${formatUsd(price)}`,
      });
      await markPriceAlertFired(alert.id);
    }
  }
}
