/**
 * Legacy preview entry. The bottom-nav "Assets" tab was renamed to "Send" - the AssetsPage
 * component no longer exists. To keep external iframe URLs that point at /assets.html
 * working, this entry now mounts the new SendPage so the visual continues to make sense:
 * the slot that used to host portfolio rows now hosts the unified Send flow.
 *
 * If the marketing site is later updated to link at /send.html directly, this entry + its
 * HTML can be deleted along with the rollup input in vite.preview-build.config.ts.
 */

import './chrome-stub';
import { SendPage } from '@/ui/pages/SendPage';
import type { Balances, Networks } from '@/ui/types';
import { BALANCES_DEFAULT } from './fixtures/balances';
import { NETWORKS } from './fixtures/networks';
import '@/ui/wallet.css';
import { mountPreview } from './mount';

function AssetsRedirectPreview() {
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

mountPreview(<AssetsRedirectPreview />, 'assets');
