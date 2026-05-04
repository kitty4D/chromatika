/**
 * Send screen preview. Mounts the real `SendPage` with David's balances + networks
 * fixtures. Form fields stay empty (SendPage starts with `useState('')` for
 * amount/recipient and we don't drive them) so visitors see the form structure plus
 * the chain chip row + SUI balance hint.
 */

import './chrome-stub';
import { SendPage } from '@/ui/pages/SendPage';
import type { Balances, Networks } from '@/ui/types';
import { BALANCES_DEFAULT } from './fixtures/balances';
import { NETWORKS } from './fixtures/networks';
import '@/ui/wallet.css';
import { mountPreview } from './mount';

function SendPreview() {
  return (
    <div className="ch-frame">
      <div className="sp-root sp-bodyScroll">
        <div className="sp-contentTrackShell" style={{ height: '100%' }}>
          <div className="sp-contentTrack ch-scrollbar" style={{ height: '100%' }}>
            <SendPage
              balances={BALANCES_DEFAULT as unknown as Balances}
              networks={NETWORKS as unknown as Networks}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

mountPreview(<SendPreview />, 'send');
