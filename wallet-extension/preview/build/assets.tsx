/**
 * Assets / portfolio preview - mounts the real `AssetsPage`. The page calls
 * `trpc.listOwnedDWalletCaps`, `trpc.getEvmTokenBalances`, `trpc.portfolioRailBalances`
 * - all backed by fixtures in the registry. Per-row mount stagger animation plays as
 * the dWallet portfolio aggregator computes USD per cap.
 */

import './chrome-stub';
import { AssetsPage } from '@/ui/pages/AssetsPage';
import type { Balances, Networks } from '@/ui/types';
import { BALANCES_DEFAULT } from './fixtures/balances';
import { NETWORKS } from './fixtures/networks';
import '@/ui/wallet.css';
import { mountPreview } from './mount';

function AssetsPreview() {
  return (
    <div className="ch-frame">
      <div className="sp-root sp-bodyScroll">
        <div className="sp-contentTrackShell" style={{ height: '100%' }}>
          <div className="sp-contentTrack ch-scrollbar" style={{ height: '100%' }}>
            <AssetsPage
              balances={BALANCES_DEFAULT as unknown as Balances}
              networks={NETWORKS as unknown as Networks}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

mountPreview(<AssetsPreview />, 'assets');
