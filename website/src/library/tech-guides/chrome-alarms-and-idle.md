# `chrome.alarms` + `chrome.idle`

two MV3 primitives chromatika uses for the auto-lock and presign-pool timers. `chrome.alarms` schedules background callbacks at fixed intervals or at specific times. `chrome.idle` reports OS user-activity state (active / idle / locked) so chromatika can react to OS screen-lock.

## chrome.alarms

```ts
chrome.alarms.create("chromatika-presign-refill", { periodInMinutes: 5 });
chrome.alarms.create("chromatika-autolock", { when: lockAtMs });
chrome.alarms.create("chromatika-phishing-refresh", { periodInMinutes: 24 * 60 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "chromatika-presign-refill") void runPresignRefill();
  if (alarm.name === "chromatika-autolock") void lock();
  if (alarm.name === "chromatika-phishing-refresh") void syncPhishingRules();
});
```

key behaviors:

- alarms persist across SW unloads (chrome stores them in extension state)
- when an alarm fires, chrome wakes the SW if it's idle - this is the only reliable way to schedule background work in MV3
- minimum interval is 30 seconds in production builds. dev builds allow 1 second
- `when` schedules a one-shot at a specific timestamp; `periodInMinutes` schedules recurring

## chromatika's alarms

| name                          | period   | purpose                               |
| ----------------------------- | -------- | ------------------------------------- |
| `chromatika-presign-refill`   | 5 min    | top up presign pools for active vault |
| `chromatika-autolock`         | one-shot | lock the wallet at `lockAtMs`         |
| `chromatika-phishing-refresh` | 24 hr    | refetch MetaMask phishing config.json |

## the autolock alarm

```ts
async function setAutolockTimer(autolockMinutes: number) {
  await chrome.alarms.clear("chromatika-autolock"); // cancel any pending
  if (autolockMinutes > 0) {
    const lockAtMs = Date.now() + autolockMinutes * 60_000;
    await chrome.alarms.create("chromatika-autolock", { when: lockAtMs });
    await chrome.storage.session.set({
      chromatika_unlock_cache_v1: { ...currentCache, lockAtMs },
    });
  }
}

// every user action resets the timer
async function recordUserActivity() {
  if (!unlocked) return;
  await setAutolockTimer(currentAutolockMinutes);
}
```

every tRPC call from a UI page counts as user activity → reset timer. user idleness (no calls) → timer fires → `lock()`.

## chrome.idle

```ts
chrome.idle.setDetectionInterval(60); // seconds of no input before going 'idle'
chrome.idle.onStateChanged.addListener((state) => {
  if (state === "locked") {
    void lock(); // OS screen-lock = wallet lock
  } else if (state === "idle") {
    // 60s of no input - could shorten autolock here if user wants
  }
  // 'active' transitions don't trigger anything special
});
```

`chrome.idle` reports three states:

- `'active'` - user is using the device
- `'idle'` - no input for `setDetectionInterval(seconds)` (default 60s, can set 15-3600s)
- `'locked'` - OS screen is locked (Windows lock screen, macOS lock, Linux screensaver, etc.)

chromatika treats `'locked'` as an immediate trigger to lock the wallet, regardless of the autolock timer. logic: if your screen is locked, your wallet should be too.

## the SW wakeup behavior

alarms are the **canonical way to wake a sleeping SW**. when an alarm fires:

1. chrome spins up the SW if needed
2. fires `chrome.alarms.onAlarm` listener
3. SW does its work
4. SW goes back to sleep ~30s later if no other activity

if you want a recurring background job, `chrome.alarms` is your tool. don't try `setInterval` - the SW gets killed; intervals don't persist.

## the dev-time alarm minimum quirk

production builds: minimum alarm period is 30 seconds. trying to set `periodInMinutes: 0.5` (30s) works; `0.49` (29.4s) doesn't.

dev builds: minimum is 1 second. useful for testing.

chromatika's 5-minute presign refill is well above either limit.

## the once-per-SW-startup pattern

some setup work needs to run on **every** SW startup (cold or restart):

- restore unlock cache from `chrome.storage.session`
- reconnect MCP host if enabled
- restore active vault id

```ts
// runs on every SW startup
chrome.runtime.onStartup.addListener(() => {
  void restoreFromStorage();
});

// also runs on install
chrome.runtime.onInstalled.addListener(() => {
  void initializeFreshInstall();
});

// also runs whenever the SW imports for the first time after sleep
// (top-level code in service worker entry point)
void restoreFromStorage();
```

three lifecycle events; chromatika handles each appropriately. `onStartup` fires when chrome boots; `onInstalled` fires on first install or update; SW top-level code runs every time SW spins up.

## the offscreen alternative (not used)

`chrome.offscreen` lets MV3 extensions create an offscreen DOM document for tasks SWs can't do (audio context, DOM parsing, etc.). chromatika **doesn't** use it today. target architecture has an offscreen media cache for NFT images; not shipped. manifest doesn't request `offscreen` permission.

## library

- browser native `chrome.alarms`, `chrome.idle`, `chrome.runtime.onStartup`, `chrome.runtime.onInstalled`
- internal: `wallet-extension/src/background/index.ts` for the wakeup wiring
- internal: `wallet-extension/src/background/session.ts` for the autolock + idle handling

## related

- [cold-sw-unlock-cache.md](/library/tech/cold-sw-unlock-cache) - the session-storage cache that survives SW unloads
- [chrome-storage-local-and-session.md](/library/tech/chrome-storage-local-and-session) - storage primitives
- [ika-presign-pool-impl.md](/library/tech/ika-presign-pool-impl) - the 5-min refill alarm consumer
- [eth-phishing-detect.md](/library/tech/eth-phishing-detect) - the daily refresh alarm consumer
