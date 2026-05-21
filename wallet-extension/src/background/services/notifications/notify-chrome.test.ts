import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockContexts: { contextType: string }[] = [];

vi.stubGlobal('chrome', {
  notifications: {
    create: vi.fn((_id: string, _opts: unknown, cb?: () => void) => cb?.()),
    clear: vi.fn((_id: string, cb?: () => void) => cb?.()),
  },
  runtime: {
    getContexts: vi.fn(async () => mockContexts),
  },
});

vi.mock('./notify-prefs', () => ({
  getNotifyPrefs: vi.fn(async () => ({
    enabled: true,
    channels: {
      incomingTx: true,
      sendConfirmation: true,
      priceAlerts: true,
      ikaEvents: true,
    },
    muted: false,
  })),
}));

vi.mock('@/background/session', () => ({
  isUnlocked: vi.fn(() => true),
}));

import { maybeFireNotification } from './notify-chrome';

beforeEach(() => {
  mockContexts = [];
  vi.clearAllMocks();
});

describe('maybeFireNotification', () => {
  it('creates notification when conditions are met', async () => {
    const fired = await maybeFireNotification('incomingTx', {
      id: 'chromatika-incoming-sui-abc',
      title: 'Received 1 SUI',
      message: 'From 0xAb...cD',
    });
    expect(fired).toBe(true);
    expect(chrome.notifications.create).toHaveBeenCalledOnce();
  });

  it('suppresses when side panel is open', async () => {
    mockContexts = [{ contextType: 'SIDE_PANEL' }];
    const fired = await maybeFireNotification('incomingTx', {
      id: 'chromatika-incoming-sui-abc',
      title: 'Received 1 SUI',
      message: 'From 0xAb...cD',
    });
    expect(fired).toBe(false);
    expect(chrome.notifications.create).not.toHaveBeenCalled();
  });

  it('suppresses when channel is disabled', async () => {
    const { getNotifyPrefs } = await import('./notify-prefs');
    vi.mocked(getNotifyPrefs).mockResolvedValueOnce({
      enabled: true,
      channels: {
        incomingTx: false,
        sendConfirmation: true,
        priceAlerts: true,
        ikaEvents: true,
      },
      muted: false,
    });
    const fired = await maybeFireNotification('incomingTx', {
      id: 'test',
      title: 'test',
      message: 'test',
    });
    expect(fired).toBe(false);
  });

  it('suppresses when wallet is locked', async () => {
    const { isUnlocked } = await import('@/background/session');
    vi.mocked(isUnlocked).mockReturnValueOnce(false);
    const fired = await maybeFireNotification('incomingTx', {
      id: 'test',
      title: 'test',
      message: 'test',
    });
    expect(fired).toBe(false);
  });

  it('suppresses when muted', async () => {
    const { getNotifyPrefs } = await import('./notify-prefs');
    vi.mocked(getNotifyPrefs).mockResolvedValueOnce({
      enabled: true,
      channels: {
        incomingTx: true,
        sendConfirmation: true,
        priceAlerts: true,
        ikaEvents: true,
      },
      muted: true,
    });
    const fired = await maybeFireNotification('incomingTx', {
      id: 'test',
      title: 'test',
      message: 'test',
    });
    expect(fired).toBe(false);
  });

  it('suppresses when master switch is off', async () => {
    const { getNotifyPrefs } = await import('./notify-prefs');
    vi.mocked(getNotifyPrefs).mockResolvedValueOnce({
      enabled: false,
      channels: {
        incomingTx: true,
        sendConfirmation: true,
        priceAlerts: true,
        ikaEvents: true,
      },
      muted: false,
    });
    const fired = await maybeFireNotification('incomingTx', {
      id: 'test',
      title: 'test',
      message: 'test',
    });
    expect(fired).toBe(false);
  });
});
