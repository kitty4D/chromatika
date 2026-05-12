/**
 * IkaStakingPage preview. Mounts the real component; trpc-mock returns null
 * for `ikaStakingValidators` / `ikaStakingPositions` (unfixured) so the page
 * shows its empty/loading state. Goal here is visual styling iteration on
 * the hero, validator picker, stake row pattern.
 */

import './chrome-stub';
import { IkaStakingPage } from '@/ui/pages/IkaStakingPage';
import type { Balances, Networks } from '@/ui/types';
import { BALANCES_DAVID } from './fixtures/balances';
import { NETWORKS } from './fixtures/networks';
import '@/ui/wallet.css';
import { mountPreview } from './mount';

function IkaStakingPreview() {
  return (
    <div className="ch-frame">
      <div className="sp-root sp-bodyScroll">
        <div className="sp-contentTrackShell" style={{ height: '100%' }}>
          <div className="sp-contentTrack ch-scrollbar" style={{ height: '100%' }}>
            <IkaStakingPage
              balances={BALANCES_DAVID as unknown as Balances}
              networks={NETWORKS as unknown as Networks}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

mountPreview(<IkaStakingPreview />, 'ika-staking');
