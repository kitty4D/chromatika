import { useLayoutEffect } from 'react';
import type { IkaBaseMode } from '@/background/ika-base-mode';
import type { AppearanceMode } from '@/background/appearance-mode';

/** sync ika base chain + appearance to <html> data-* for CSS theme selectors */
export function useChromatikaThemeDocument(ikaChain: IkaBaseMode, appearance: AppearanceMode) {
  useLayoutEffect(() => {
    const el = document.documentElement;
    el.dataset.ikaChain = ikaChain;
    el.dataset.appearance = appearance;
  }, [ikaChain, appearance]);
}
