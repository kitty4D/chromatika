/**
 * ChromaLabPage preview. Lab tooling for Sui + Solana dWallet protocol exploration.
 * trpc-mock returns null for getChromaLabRefs / getSuiExplorerOverview / etc so
 * each panel shows its own empty/loading state. Goal: visual styling iteration on
 * the disclaimer banner, ref selector, per-protocol explorer panels.
 */

import './chrome-stub';
import { ChromaLabPage } from '@/ui/pages/ChromaLabPage';
import type { Balances } from '@/ui/types';
import { BALANCES_DAVID } from './fixtures/balances';
import '@/ui/wallet.css';
import { mountPreview } from './mount';

function ChromaLabPreview() {
  return (
    <div className="ch-frame">
      <div className="sp-root sp-bodyScroll">
        <div className="sp-contentTrackShell" style={{ height: '100%' }}>
          <div className="sp-contentTrack ch-scrollbar" style={{ height: '100%' }}>
            <ChromaLabPage
              ikaMode="sui"
              balances={BALANCES_DAVID as unknown as Balances}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

mountPreview(<ChromaLabPreview />, 'chroma-lab');
