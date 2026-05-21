import { isUnlocked } from '@/background/session';
import { getNotifyPrefs } from './notify-prefs';
import type { NotifyChannel } from './types';

type NotificationPayload = {
  id: string;
  title: string;
  message: string;
  iconUrl?: string;
};

async function isWalletUiFocused(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [
        'SIDE_PANEL' as chrome.runtime.ContextType,
        'POPUP' as chrome.runtime.ContextType,
      ],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

export async function maybeFireNotification(
  channel: NotifyChannel,
  payload: NotificationPayload,
): Promise<boolean> {
  if (!isUnlocked()) return false;

  const prefs = await getNotifyPrefs();
  if (!prefs.enabled) return false;
  if (prefs.muted) return false;
  if (!prefs.channels[channel]) return false;

  if (await isWalletUiFocused()) return false;

  return new Promise((resolve) => {
    chrome.notifications.create(
      payload.id,
      {
        type: 'basic',
        iconUrl: payload.iconUrl ?? 'icons/icon-128.png',
        title: payload.title,
        message: payload.message,
        priority: 1,
      },
      () => resolve(true),
    );
  });
}

export function clearNotification(id: string): void {
  chrome.notifications.clear(id);
}
