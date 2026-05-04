/**
 * dWallet portfolio preview - mounts `DWalletPortfolioPage` showing David's SECP256K1
 * dWallet (cross-chain evm + btc address rails). Per-rail balances render from the
 * registry. Receive sheet, rail switcher, and the per-row entrance animations all
 * play on mount.
 */

import './chrome-stub';
import { DWalletPortfolioPage } from '@/ui/pages/DWalletPortfolioPage';
import type { Balances, Networks } from '@/ui/types';
import { BALANCES_DEFAULT } from './fixtures/balances';
import { NETWORKS } from './fixtures/networks';
import { DWALLET_CAPS_DAVID } from './fixtures/dwallets';
import '@/ui/wallet.css';
import { mountPreview } from './mount';

function DWalletsPreview() {
  return (
    <div className="ch-frame">
      <div className="sp-root sp-bodyScroll">
        <div className="sp-contentTrackShell" style={{ height: '100%' }}>
          <div className="sp-contentTrack ch-scrollbar" style={{ height: '100%' }}>
            <DWalletPortfolioPage
              dwalletId={DWALLET_CAPS_DAVID[0].dwalletId}
              balances={BALANCES_DEFAULT as unknown as Balances}
              networks={NETWORKS as unknown as Networks}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

mountPreview(<DWalletsPreview />, 'dwallets');
