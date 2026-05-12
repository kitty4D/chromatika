/**
 * PaymentsPage preview (x402). The page composes three sections:
 * PaymentsSettingsSection, X402ReceiptsSection, X402PrivateReceiptsSection.
 * trpc-mock returns null for unfixured procs so each section renders its
 * empty state. Goal: visual styling iteration on the page header + section
 * blocks + per-receipt row pattern.
 */

import './chrome-stub';
import { PaymentsPage } from '@/ui/pages/PaymentsPage';
import '@/ui/wallet.css';
import { mountPreview } from './mount';

const noop = () => {};

function PaymentsPreview() {
  return (
    <div className="ch-frame">
      <div className="sp-root sp-bodyScroll">
        <div className="sp-contentTrackShell" style={{ height: '100%' }}>
          <div className="sp-contentTrack ch-scrollbar" style={{ height: '100%' }}>
            <PaymentsPage onBack={noop} />
          </div>
        </div>
      </div>
    </div>
  );
}

mountPreview(<PaymentsPreview />, 'payments');
