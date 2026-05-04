/** blur + shutter in, hold, out; keep in sync with theme-flash.css ~0.22s transitions */
const FLASH_IN_MS = 220;
const FLASH_HOLD_MS = 180;
const FLASH_OUT_MS = 220;

function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = () => {
      if (count <= 0) resolve();
      else {
        count -= 1;
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * full-viewport backdrop blur while `apply` runs (theme / html data-* update).
 * skipped when prefers-reduced-motion is set.
 */
export async function runChromatikaThemeFlash(apply: () => void | Promise<void>): Promise<void> {
  if (typeof window === 'undefined') {
    await apply();
    return;
  }
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    await apply();
    return;
  }

  const html = document.documentElement;
  html.classList.add('ch-theme-flash');
  await nextFrames(2);
  html.classList.add('ch-theme-flash--on');
  await sleep(FLASH_IN_MS);
  await apply();
  await nextFrames(2);
  await sleep(FLASH_HOLD_MS);
  html.classList.remove('ch-theme-flash--on');
  await sleep(FLASH_OUT_MS);
  html.classList.remove('ch-theme-flash');
}
