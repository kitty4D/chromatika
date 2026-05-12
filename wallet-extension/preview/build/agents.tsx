/**
 * AgentsPage preview (MCP native-host surface). trpc-mock returns null for
 * `mcpStatus` / `mcpToken` etc so the page shows the "not connected" state.
 * Goal: visual styling iteration on the status hero + token display + setup blocks.
 */

import './chrome-stub';
import { AgentsPage } from '@/ui/pages/AgentsPage';
import '@/ui/wallet.css';
import { mountPreview } from './mount';

const noop = () => {};

function AgentsPreview() {
  return (
    <div className="ch-frame">
      <div className="sp-root sp-bodyScroll">
        <div className="sp-contentTrackShell" style={{ height: '100%' }}>
          <div className="sp-contentTrack ch-scrollbar" style={{ height: '100%' }}>
            <AgentsPage onBack={noop} />
          </div>
        </div>
      </div>
    </div>
  );
}

mountPreview(<AgentsPreview />, 'agents');
