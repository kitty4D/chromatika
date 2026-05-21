export type NotifyChannel = 'incomingTx' | 'sendConfirmation' | 'priceAlerts' | 'ikaEvents';

export type NotifyPrefs = {
  enabled: boolean;
  channels: Record<NotifyChannel, boolean>;
  muted: boolean;
};

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  enabled: true,
  channels: {
    incomingTx: true,
    sendConfirmation: true,
    priceAlerts: true,
    ikaEvents: true,
  },
  muted: false,
};

export type CursorEntry = {
  lastCursor: string | null;
  lastPollAtMs: number;
};

export type NotifyCursors = Record<string, CursorEntry>;

export type PriceAlertDirection = 'above' | 'below';

export type PriceAlert = {
  id: string;
  symbol: string;
  direction: PriceAlertDirection;
  thresholdUsd: number;
  createdAtMs: number;
  firedAtMs?: number;
};

export type PriceAlertStore = {
  alerts: PriceAlert[];
};

export const MAX_PRICE_ALERTS = 20;

export const CHAIN_POLL_INTERVALS: Record<string, number> = {
  sui: 30_000,
  solana: 30_000,
  evm: 60_000,
  btc: 300_000,
};

export const NOTIFY_ALARM_NAME = 'chromatika-notify-poll';
export const NOTIFY_ALARM_PERIOD_MIN = 0.5;
