/** tab broadcast for injected providers - lives in its own module to avoid circular imports with `index.ts` ↔ `router.ts`. */

export function broadcastToTabs(event: string, data?: unknown): void {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs
          .sendMessage(tab.id, { type: 'chromatika-push', event, data })
          .catch(() => { /* tab may not have content script */ });
      }
    }
  });
}
