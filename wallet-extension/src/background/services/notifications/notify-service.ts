import { isUnlocked } from '@/background/session';
import { getNotifyPrefs } from './notify-prefs';
import { checkIncomingTransactions } from './incoming-tx-checker';
import { checkPriceAlerts } from './price-alert-checker';

export async function handleNotifyPollAlarm(): Promise<void> {
  if (!isUnlocked()) return;

  const prefs = await getNotifyPrefs();
  if (!prefs.enabled) return;

  const jobs: Promise<void>[] = [];

  if (prefs.channels.incomingTx) {
    jobs.push(checkIncomingTransactions());
  }

  if (prefs.channels.priceAlerts) {
    jobs.push(checkPriceAlerts());
  }

  await Promise.allSettled(jobs);
}
