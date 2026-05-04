import { TitleBar } from '@/ui/components/TitleBar';
import type { IkaBaseMode } from '@/background/ika-base-mode';

/** @deprecated prefer `TitleBar` directly; kept for older call sites. */
export function AppChromeHeader({
  variant,
  mode,
  onSelect,
  onActiveSameMode,
  onOpenSettings,
  modeSize,
}: {
  variant: 'wallet' | 'onboarding';
  mode: IkaBaseMode;
  onSelect: (m: IkaBaseMode) => void | Promise<void>;
  onActiveSameMode?: () => void;
  onOpenSettings?: () => void;
  modeSize?: 'xs' | 'sm' | 'md';
}) {
  return (
    <TitleBar
      variant={variant}
      mode={mode}
      onSelect={onSelect}
      onActiveSameMode={onActiveSameMode}
      onOpenSettings={onOpenSettings}
      modeSize={modeSize}
    />
  );
}
