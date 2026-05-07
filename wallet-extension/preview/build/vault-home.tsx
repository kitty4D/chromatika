/**
 * Vault / home preview - mounts the *full* `MainWalletShell` so the iframe shows the
 * complete wallet chrome (TitleBar at top, VaultContextHeader, DWalletContextBar,
 * the WalletPage body, and the BottomNav + CollapsibleIkaLabDrawer at the bottom)
 * around demo vaults (David sui-base + Toly solana-base). Marketing iframe consumers
 * see the same shell as prod; ika base swaps switch the mocked active vault +
 * balances to match the prod `switchVault`-style UX.
 */

import './chrome-stub';
import { useMemo, useState } from 'react';
import { MainWalletShell, type WalletShellOverlay } from '@/ui/MainWalletShell';
import type { Balances, Networks, Tab } from '@/ui/types';
import type { AppearanceMode } from '@/background/appearance-mode';
import { BALANCES_DAVID, BALANCES_TOLY } from './fixtures/balances';
import { NETWORKS } from './fixtures/networks';
import { DAVID } from './fixtures/personas';
import { VAULT_SUMMARIES } from './fixtures/dwallets';
import { useIkaBaseMode } from '@/lib/use-ika-base-mode';
import { useChromatikaThemeDocument } from '@/lib/use-theme-document';
import '@/ui/wallet.css';
import { mountPreview } from './mount';

const noop = () => {};
const noopAsync = async () => {};

function VaultHomeShellPreview() {
  const [tab, setTab] = useState<Tab>('vault');
  const [walletOverlay, setWalletOverlay] = useState<WalletShellOverlay>(null);
  const [advanced, setAdvanced] = useState(false);
  const [uiHelpHints, setUiHelpHints] = useState(false);
  const [appearance, setAppearance] = useState<AppearanceMode>('dark');

  const { mode: ikaMode, setMode: setIkaBaseModePersist } = useIkaBaseMode();
  const ikaEffective = ikaMode ?? 'sui';
  useChromatikaThemeDocument(ikaEffective, appearance);

  const activeVaultId = useMemo(() => {
    const v = VAULT_SUMMARIES.find((x) => x.baseChain === ikaEffective);
    return v?.id ?? DAVID.id;
  }, [ikaEffective]);

  const balancesFixture = ikaEffective === 'solana' ? BALANCES_TOLY : BALANCES_DAVID;
  const vaultLabelFallback =
    VAULT_SUMMARIES.find((v) => v.id === activeVaultId)?.label ?? DAVID.label;

  return (
    <div className="ch-frame">
      <MainWalletShell
        ikaMode={ikaEffective}
        onIkaModeSelect={(m) => void setIkaBaseModePersist(m)}
        balances={balancesFixture as unknown as Balances}
        balanceError={null}
        networks={NETWORKS as unknown as Networks}
        advanced={advanced}
        onAdvancedChange={setAdvanced}
        uiHelpHints={uiHelpHints}
        onUiHelpHintsChange={setUiHelpHints}
        appearance={appearance}
        setAppearance={(v) => {
          setAppearance(v);
        }}
        vaultSummaries={VAULT_SUMMARIES}
        activeVaultId={activeVaultId}
        vaultLabelFallback={vaultLabelFallback}
        tab={tab}
        setTab={setTab}
        walletOverlay={walletOverlay}
        setWalletOverlay={setWalletOverlay}
        refresh={noop}
        onVaultSwitched={noop}
        onDwalletBarSwitched={noop}
      />
    </div>
  );
}

void noopAsync;

mountPreview(<VaultHomeShellPreview />, 'vault-home');
