/**
 * when this document runs a local theme change (flash + persist), chrome.storage.onChanged
 * also fires here. skip the remote-flash path so we don't double-veil; persist still sets state.
 */
let suppressedUntil = 0;

const WINDOW_MS = 2000;

export function markLocalThemeChangeFromThisDocument(): void {
  suppressedUntil = Date.now() + WINDOW_MS;
}

export function shouldSkipStorageDrivenThemeFlash(): boolean {
  return Date.now() < suppressedUntil;
}
