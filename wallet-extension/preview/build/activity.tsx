/**
 * Activity feed preview. Mounts the real `ActivityPage`; `trpc.getActivity` resolves
 * to the David-Toly activity fixture from the registry. Per-row entrance animation
 * (defined in wallet.css `.sp-activityRow`) plays as items render.
 *
 * advanced=true exposes the per-row digest + ExplorerValueRow chip for visual depth.
 */

import './chrome-stub';
import { ActivityPage } from '@/ui/pages/ActivityPage';
import type { Balances, Networks } from '@/ui/types';
import { BALANCES_DEFAULT } from './fixtures/balances';
import { NETWORKS } from './fixtures/networks';
import '@/ui/wallet.css';
import { mountPreview } from './mount';

function ActivityPreview() {
  return (
    <div className="ch-frame">
      <div className="sp-root sp-bodyScroll">
        <div className="sp-contentTrackShell" style={{ height: '100%' }}>
          <div className="sp-contentTrack ch-scrollbar" style={{ height: '100%' }}>
            <ActivityPage
              balances={BALANCES_DEFAULT as unknown as Balances}
              networks={NETWORKS as unknown as Networks}
              advanced={true}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

mountPreview(<ActivityPreview />, 'activity');
