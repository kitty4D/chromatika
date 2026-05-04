/**
 * position extension popup windows near the right edge of the last focused browser window.
 */
export async function getPopupPosition(
  popupWidth: number,
): Promise<{ left?: number; top?: number }> {
  try {
    const w = await chrome.windows.getLastFocused({ populate: false });
    if (w.left == null || w.width == null || w.top == null) return {};
    const left = Math.max(0, w.left + w.width - popupWidth - 16);
    const top = w.top + 80;
    return { left, top };
  } catch {
    return {};
  }
}
