import { useState, type CSSProperties } from 'react';
import { trpc } from '@/lib/trpc';
import type { WalletSetupSurface } from '../internal';
import type { WalletSetupHook } from '../use-wallet-setup';
import type { ScanResult } from '@/background/scan/scan-types';
import type { ScanChainEntry } from '@/config/scan-chains';
import { ScanResultsView } from '@/ui/scan/ScanResultsView';

/**
 * recovery-phrase import step. supports two flows:
 *   - **standard**: type phrase, click "import vault", account 0 is persisted.
 *   - **advanced (scan first)**: opt into the activity scan, see which BIP44 accounts have
 *     activity / dwallets / balances on Sui mainnet + Solana mainnet + Solana devnet (+ super-pro
 *     chains), then import one or many accounts as separate vaults via `importVaultsBatch`.
 *
 * the scan state is stored locally - no global wallet-setup-flow state-machine bump needed,
 * keeps the diff small + lets the rest of the import flow stay untouched.
 */
export function ImportStep({
  surface,
  box,
  hook,
}: {
  surface: WalletSetupSurface;
  box: CSSProperties;
  hook: WalletSetupHook;
}) {
  const {
    mode,
    setStep,
    setError,
    mnemonicIn,
    setMnemonicIn,
    error,
    importBusy,
    onImport,
    password,
    onVaultReady,
  } = hook;

  const importCls = `ws-import ws-import--${surface}`;
  const inputCls = surface === 'sidepanel' ? 'sp-input' : undefined;

  // advanced-flow local state - lives only here.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [superProIds, setSuperProIds] = useState<Set<string>>(new Set());
  const [superProChains, setSuperProChains] = useState<ScanChainEntry[]>([]);

  async function loadSuperProChainsIfNeeded() {
    if (superProChains.length > 0) return;
    try {
      const list = await trpc.scanListSuperProChains.query();
      setSuperProChains(list);
    } catch {
      /* leave empty - user can still see results without picker */
    }
  }

  async function runScan(superProSelected: Set<string>) {
    const phrase = mnemonicIn.trim();
    if (!phrase) {
      setScanError('enter your recovery phrase first');
      return;
    }
    setScanBusy(true);
    setScanError(null);
    void loadSuperProChainsIfNeeded();
    try {
      const result = await trpc.scanForHd.mutate({
        mnemonic: phrase,
        defaults: true,
        superProChainIds: Array.from(superProSelected),
      });
      setScanResult(result);
      // pre-check the suggested rows so the user doesn't have to think about it.
      setSelectedKeys(new Set(result.suggestedKeys));
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanBusy(false);
    }
  }

  async function importSelected() {
    if (!scanResult || selectedKeys.size === 0) return;
    if (mode === 'addVault') {
      setScanError('multi-account import for addVault flow is not yet supported here; use the post-unlock settings entry instead.');
      return;
    }
    if (password.length < 8) {
      setScanError('password must be at least 8 characters');
      return;
    }
    const phrase = mnemonicIn.trim();
    setScanBusy(true);
    setScanError(null);
    try {
      const accounts = scanResult.rows
        .filter((r) => selectedKeys.has(r.candidate.key))
        .filter((r) => r.candidate.accountIndex !== undefined)
        .map((r) => ({
          accountIndex: r.candidate.accountIndex!,
          label: `account ${r.candidate.accountIndex!}`,
        }));
      if (accounts.length === 0) {
        setScanError('select at least one account to import.');
        return;
      }
      await trpc.importVaultsBatch.mutate({ password, mnemonic: phrase, accounts });
      // unlock immediately so the side panel transitions to main view, mirroring the standard import flow.
      await trpc.unlockVault.mutate({ password, autoLockMinutes: 30 });
      setMnemonicIn('');
      onVaultReady();
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanBusy(false);
    }
  }

  if (scanResult) {
    return (
      <div style={box} className={importCls}>
        <h2 style={{ margin: '0 0 8px' }}>scan results</h2>
        <ScanResultsView
          result={scanResult}
          superProChains={superProChains}
          selectedKeys={selectedKeys}
          onSelectionChange={setSelectedKeys}
          selectedSuperProIds={superProIds}
          onSuperProSelectionChange={setSuperProIds}
          onRescan={() => runScan(superProIds)}
          onImport={() => void importSelected()}
          busy={scanBusy}
        />
        {scanError && <p className="ws-password-error" style={{ marginTop: 12 }}>{scanError}</p>}
        <button
          type="button"
          className="ws-password-btn ws-password-btn--ghost"
          style={{ marginTop: 12 }}
          disabled={scanBusy}
          onClick={() => {
            setScanResult(null);
            setSelectedKeys(new Set());
          }}
        >
          back to phrase
        </button>
      </div>
    );
  }

  return (
    <form
      style={box}
      className={importCls}
      onSubmit={(e) => {
        e.preventDefault();
        void onImport();
      }}
    >
      <div className="ws-import-brand">
        <img className="ws-import-logo" src="/chromatika-clean-key.png" alt="" width={100} height={100} />
        <h2 className="ws-import-title">
          {mode === 'addVault' ? 'import another vault' : 'import your phrase'}
        </h2>
        <p className="ws-import-sub">
          paste the 12 or 24 word recovery phrase for this dWallet Vault. it stays on this device and is never uploaded.
        </p>
      </div>
      <p className="ws-import-lead">
        separate words with spaces - extra spaces are fine; we normalize before validating the phrase.
      </p>
      <div className="ws-import-phrase">
        <label className="ws-import-phrase-label" htmlFor="ws-import-mnemonic-field">
          recovery phrase
        </label>
        <textarea
          id="ws-import-mnemonic-field"
          placeholder="word1 word2 word3 …"
          value={mnemonicIn}
          onChange={(e) => setMnemonicIn(e.target.value)}
          className={['ws-import-mnemonic', inputCls].filter(Boolean).join(' ')}
          spellCheck={false}
          autoComplete="off"
          disabled={importBusy || scanBusy}
          style={importBusy ? { filter: 'blur(12px)', userSelect: 'none', pointerEvents: 'none', transition: 'filter 0.15s ease-out' } : { transition: 'filter 0.15s ease-out' }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            e.preventDefault();
            (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
          }}
        />
      </div>
      {error && <p className="ws-password-error">{error}</p>}
      {importBusy && (
        <p className="ws-import-hint">encrypting vault and deriving keys - stay on this screen…</p>
      )}

      {mode !== 'addVault' && (
        <details
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
          style={{ marginTop: 16, padding: '10px 12px', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}
        >
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>
            advanced: scan derivation paths first
          </summary>
          <p style={{ margin: '8px 0', fontSize: 12, opacity: 0.75, lineHeight: 1.5 }}>
            checks bip44 accounts 0..N on this phrase across sui mainnet + solana mainnet + solana
            devnet for activity, balances, and existing dwallets. you can pick which accounts to
            import; super-pro mode adds evm L2s + bitcoin + aptos.
          </p>
          {scanError && <p className="ws-password-error" style={{ margin: '8px 0' }}>{scanError}</p>}
          <button
            type="button"
            className="ws-password-btn ws-password-btn--ghost"
            disabled={scanBusy || importBusy || !mnemonicIn.trim()}
            onClick={() => void runScan(superProIds)}
          >
            {scanBusy ? 'scanning…' : 'scan now'}
          </button>
        </details>
      )}

      <div className="ws-import-actions">
        <button
          type="submit"
          className="ws-password-btn ws-password-btn--primary"
          disabled={importBusy || scanBusy}
        >
          {importBusy ? 'working…' : mode === 'addVault' ? 'add vault' : 'import vault (account 0)'}
        </button>
        <button
          type="button"
          className="ws-password-btn ws-password-btn--ghost"
          disabled={importBusy || scanBusy}
          onClick={() => {
            setError(null);
            setStep('password');
          }}
        >
          back to password
        </button>
      </div>
    </form>
  );
}
