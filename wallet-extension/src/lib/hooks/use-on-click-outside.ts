import { useEffect, useRef, type RefObject } from 'react';

/**
 * calls `onOutside` when a pointer goes down outside `ref.current` (capture phase).
 * use while a popover/menu is `active` so clicks elsewhere dismiss it.
 */
export function useOnClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onOutside: () => void,
  active: boolean,
) {
  const onOutsideRef = useRef(onOutside);
  onOutsideRef.current = onOutside;

  useEffect(() => {
    if (!active) return;

    const onPointerDown = (e: PointerEvent) => {
      const el = ref.current;
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (!el || el.contains(t)) return;
      onOutsideRef.current();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [active, ref]);
}
