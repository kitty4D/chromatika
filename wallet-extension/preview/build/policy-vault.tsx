/**
 * PolicyVaultPage preview. On-chain spend caps + panic + rescue.
 * trpc-mock returns null for unfixured procs so the page shows its empty
 * "no policy vault active" state. Goal: visual styling iteration on the
 * page header, panic button, caps display, audit log row pattern.
 */

import './chrome-stub';
import { PolicyVaultPage } from '@/ui/pages/PolicyVaultPage';
import '@/ui/wallet.css';
import { mountPreview } from './mount';

function PolicyVaultPreview() {
  return (
    <div className="ch-frame">
      <div className="sp-root sp-bodyScroll">
        <div className="sp-contentTrackShell" style={{ height: '100%' }}>
          <div className="sp-contentTrack ch-scrollbar" style={{ height: '100%' }}>
            <PolicyVaultPage />
          </div>
        </div>
      </div>
    </div>
  );
}

mountPreview(<PolicyVaultPreview />, 'policy-vault');
