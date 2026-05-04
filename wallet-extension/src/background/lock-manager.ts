import { lockWallet } from '@/background/wallet-service';

const LOCK_ALARM = 'chromatika-auto-lock';
/** chrome.idle: only lock on OS screen lock - browser "idle" would fire during long txn review in popup */
let idleListenerRegistered = false;

export function scheduleLock(delayMinutes: number): void {
  chrome.alarms.create(LOCK_ALARM, { delayInMinutes: delayMinutes });
}

export function clearLockSchedule(): void {
  chrome.alarms.clear(LOCK_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOCK_ALARM) {
    lockWallet();
  }
});

function registerIdleLockIfNeeded(): void {
  if (idleListenerRegistered) return;
  if (typeof chrome.idle?.onStateChanged?.addListener !== 'function') return;
  idleListenerRegistered = true;
  try {
    chrome.idle.setDetectionInterval(60);
  } catch {
    /* noop */
  }
  chrome.idle.onStateChanged.addListener((newState) => {
    if (newState === 'locked') lockWallet();
  });
}

registerIdleLockIfNeeded();
