import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { DWalletPanel } from '@/ui/dwallet-panel';
import type { Balances, Networks } from '@/ui/types';

export function DWalletManagementScreen({
  balances,
  networks,
  advanced,
  onBack,
  onRefresh: _onRefresh,
}: {
  balances: Balances;
  networks: Networks | null;
  advanced: boolean;
  onBack: () => void;
  /** reserved for post-ika-ops refresh wiring */
  onRefresh?: () => void;
}) {
  void _onRefresh;
  const [copied, setCopied] = useState<string | null>(null);
  const canIka = balances.funding?.ready === true;
  const suiAddr = balances.canonicalReceiveAddress ?? '';
  const feeAddr = balances.feePayerAddress ?? '';

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="sp-page">
      <div className="cv-vaultMgmt-head">
        <button type="button" className="sp-backBtn" onClick={onBack}>
          ← back
        </button>
        <div className="sp-pageTitle" style={{ marginBottom: 0 }}>
          dWallet management
        </div>
      </div>
      <p className="sp-muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
        sui receive + fee payer, network, ika tools, and address book.
      </p>

      <div className="sp-section" style={{ marginTop: 0 }}>
        <div className="sp-sectionTitle">
          {balances.canonicalSource === 'dwallet_ed25519_active' ? 'sui address (dWallet)' : 'sui address'}
        </div>
        <div className="sp-addressRow">
          <span className="sp-address">{suiAddr}</span>
          <button
            type="button"
            className="ch-copyIconBtn ch-copyIconBtn--12"
            aria-label={copied === 'sui' ? 'copied' : 'copy address'}
            onClick={() => void copy(suiAddr, 'sui')}
          >
            {copied === 'sui' ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2} />}
          </button>
        </div>
      </div>

      {advanced && (
        <div className="sp-section sp-advancedSection" style={{ marginTop: 0 }}>
          <div className="sp-sectionTitle">fee payer (HD)</div>
          <div className="sp-addressRow">
            <span className="sp-address sp-addressSmall">{feeAddr}</span>
            <button
              type="button"
              className="ch-copyIconBtn ch-copyIconBtn--12"
              aria-label={copied === 'fee' ? 'copied' : 'copy fee address'}
              onClick={() => void copy(feeAddr, 'fee')}
            >
              {copied === 'fee' ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2} />}
            </button>
          </div>
        </div>
      )}

      <div className="sp-section" style={{ marginTop: 0 }}>
        <div className="sp-sectionTitle">network</div>
        <div className="sp-muted" style={{ fontSize: 13 }}>
          {balances.network}
        </div>
        {networks ? (
          <div className="sp-muted" style={{ fontSize: 11, marginTop: 6 }}>
            evm:{' '}
            {networks.evm.find((n) => n.chainId === networks.active.evmChainId)?.name ?? `chain ${networks.active.evmChainId}`}
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 8 }}>
        <DWalletPanel enabled={canIka} />
      </div>
    </div>
  );
}
