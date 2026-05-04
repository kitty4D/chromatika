/**
 * Vault / home preview - mounts the real `WalletPage` showing David's vault
 * summary with the dWallet portfolio cards, balance row, and swap entry-point.
 * The `DWalletReorderList` mount animations replay on every page load.
 *
 * Trpc calls (`listOwnedDWalletCaps`, `dwalletAddressBook`, `getDwalletDisplayNames`,
 * `getDwalletCardOrder`) all resolve from the registry fixtures keyed to David.
 */

import './chrome-stub';
import { WalletPage } from '@/ui/pages/WalletPage';
import type { Balances, Networks } from '@/ui/types';
import { BALANCES_DEFAULT } from './fixtures/balances';
import { NETWORKS } from './fixtures/networks';
import { DAVID } from './fixtures/personas';
import '@/ui/wallet.css';
import { mountPreview } from './mount';

const noop = () => {};

function VaultHomePreview() {
  return (
    <div className="ch-frame">
      <div className="sp-root sp-bodyScroll">
        <div className="sp-contentTrackShell" style={{ height: '100%' }}>
          <div className="sp-contentTrack ch-scrollbar" style={{ height: '100%' }}>
            <WalletPage
              balances={BALANCES_DEFAULT as unknown as Balances}
              networks={NETWORKS as unknown as Networks}
              vaultLabel={DAVID.label}
              uiHelpHints={false}
              onRefresh={noop}
              onViewPortfolio={noop}
              onOpenDWalletMgmt={noop}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

mountPreview(<VaultHomePreview />, 'vault-home');
