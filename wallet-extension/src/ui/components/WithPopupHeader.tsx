import type { ReactNode } from 'react';
import { TitleBar } from '@/ui/components/TitleBar';
import { ApprovalTitleBar } from '@/ui/components/ApprovalTitleBar';
import type { IkaBaseMode } from '@/background/ika-base-mode';

type PopupChromeHeader = 'full' | 'approval' | 'none';
type PopupDocumentTrack = 'start' | 'center';

/** extension popup document chrome aligned with side panel (`sp-root` + `sp-bodyScroll` + track), not `wc-root` / `wc-popupBody` */
export function WithPopupHeader({
  children,
  ikaMode,
  onIkaMode,
  headerMode = 'full',
  onOpenSettings,
  onActiveSameMode,
  unlockChrome = false,
  track = 'start',
}: {
  children: ReactNode;
  ikaMode: IkaBaseMode;
  onIkaMode: (m: IkaBaseMode) => void | Promise<void>;
  /** `full` = ika TitleBar; `approval` = minimal wordmark only */
  headerMode?: PopupChromeHeader;
  onOpenSettings?: () => void;
  onActiveSameMode?: () => void;
  /** `sp-unlock` palette for setup + password unlock */
  unlockChrome?: boolean;
  /** `center` = loading / unlock form; `start` = setup flow + approval sheets */
  track?: PopupDocumentTrack;
}) {
  const trackClass =
    track === 'center'
      ? 'sp-contentTrack ch-scrollbar sp-contentTrack--center'
      : 'sp-contentTrack ch-scrollbar';

  return (
    <div
      className={['sp-root', 'sp-popupDocumentShell', unlockChrome ? 'sp-unlock' : ''].filter(Boolean).join(' ')}
    >
      {headerMode === 'full' && (
        <TitleBar
          variant="wallet"
          mode={ikaMode}
          onSelect={(x) => void onIkaMode(x)}
          onOpenSettings={onOpenSettings}
          onActiveSameMode={onActiveSameMode}
          modeSize="xs"
        />
      )}
      {headerMode === 'approval' && <ApprovalTitleBar />}
      <div className="sp-bodyScroll">
        <div className="sp-contentTrackShell">
          <div className={trackClass}>{children}</div>
        </div>
      </div>
    </div>
  );
}
