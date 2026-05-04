/** active browser tab URL/origin for side panel vault header (dapp connection context). */

export type ActiveTabContext = {
  url: string | null;
  origin: string | null;
  /** active tab document title (for dapp display in chrome) */
  title: string | null;
};

export async function getActiveTabContext(): Promise<ActiveTabContext> {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query) {
      return { url: null, origin: null, title: null };
    }
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab0 = tabs[0];
    const url = tab0?.url ?? null;
    const title = tab0?.title?.trim() || null;
    if (!url || url.startsWith('chrome-extension://') || url.startsWith('chrome://') || url.startsWith('about:')) {
      return { url, origin: null, title };
    }
    try {
      return { url, origin: new URL(url).origin, title };
    } catch {
      return { url, origin: null, title };
    }
  } catch {
    return { url: null, origin: null, title: null };
  }
}
