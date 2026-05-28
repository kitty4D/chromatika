import { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { formatUsd } from '@/lib/sui-amount';
import { PolicyVaultBanner } from '@/ui/components/PolicyVaultBanner';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import { PreviewDisabledTooltip } from '@/ui/components/PreviewDisabledTooltip';
import { activityTxExplorerHref } from '@/lib/explorer-href';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import { useSendAmountInputMode } from '@/lib/use-send-amount-input-mode';
import { AmountInputControl } from '@/ui/pages/send/AmountInputControl';
import type { Balances, Networks } from '@/ui/types';
import type {
  SendPolicyLinkSnapshot,
  SendTokenChain,
  SendTokenNetworkFilter,
  SendTokenRow,
  SendTokenScope,
} from '@/background/services/send-token-types';

type SendNav = import('@/ui/MainWalletShell').SendNav;
type Stage = 'select-token' | 'select-recipient' | 'confirm' | 'status';

type AddressBookEntry = Awaited<ReturnType<typeof trpc.addressBookList.query>>['entries'][number];
type RecentRecipient = Awaited<ReturnType<typeof trpc.recentRecipients.query>>['entries'][number];

const SCOPE_LABELS: Record<SendTokenScope, string> = {
  dwallet: 'This dWallet only',
  vault: 'Vault owner (fee payer)',
  everything: 'All of this Vault',
};

/** companion tooltip explainers for each scope - same keys as `SCOPE_LABELS`. */
export const SCOPE_TOOLTIPS: Record<SendTokenScope, string> = {
  dwallet: 'Send from the dWallet you have selected. This is the identity dapps see.',
  vault: 'Send from the vault owner account (the fee payer). This is the keyring that pays network gas.',
  everything: 'Show every sendable balance across this Vault (the owner + all its dWallets).',
};

const CHAIN_LABELS: Record<SendTokenChain, string> = {
  evm: 'EVM',
  sui: 'Sui',
  solana: 'Solana',
  btc: 'Bitcoin',
  aptos: 'Aptos',
};

const NATIVES_PRICED_BY_POLICY_V0 = new Set(['ETH', 'SUI', 'SOL', 'MATIC']);

// ---------------------------------------------------------------------------
// page-level state machine
// ---------------------------------------------------------------------------

export function SendPage({
  balances,
  networks,
  sendNav,
  onSendNavConsumed,
}: {
  balances: Balances | null;
  networks: Networks | null;
  sendNav?: SendNav | null;
  onSendNavConsumed?: () => void;
}) {
  void balances; // future: locked/balance gating per stage
  const [stage, setStage] = useState<Stage>('select-token');
  const [selectedToken, setSelectedToken] = useState<SendTokenRow | null>(null);
  const [recipient, setRecipient] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [sendResult, setSendResult] = useState<
    | { kind: 'pending' }
    | { kind: 'submitted'; txid: string }
    | { kind: 'failed'; message: string }
    | null
  >(null);
  const [policyLinksByOwner, setPolicyLinksByOwner] = useState<Record<string, SendPolicyLinkSnapshot>>({});

  // consume sendNav preselect on first mount: portfolio quick-send + PC-Token deep-link.
  useEffect(() => {
    if (!sendNav) return;
    if (sendNav.preselectedToken) {
      setSelectedToken(sendNav.preselectedToken);
      setStage(sendNav.initialStage ?? 'select-recipient');
    } else if (sendNav.initialStage) {
      setStage(sendNav.initialStage);
    }
    // PC-Token deep-link is no longer honored here; the dedicated `HiddenTransferForm`
    // flow stays accessible from the portfolio row when needed.
    onSendNavConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="sp-page">
      <h2 className="sp-pageTitle">send</h2>

      <PolicyVaultBanner />

      {stage === 'select-token' && (
        <SelectTokenStep
          onPick={(row, linksByOwner) => {
            setSelectedToken(row);
            setPolicyLinksByOwner(linksByOwner);
            setStage('select-recipient');
          }}
        />
      )}

      {stage === 'select-recipient' && selectedToken && (
        <SelectRecipientStep
          token={selectedToken}
          recipient={recipient}
          onRecipientChange={setRecipient}
          onBack={() => setStage('select-token')}
          onNext={() => setStage('confirm')}
        />
      )}

      {stage === 'confirm' && selectedToken && (
        <ConfirmStep
          token={selectedToken}
          recipient={recipient}
          amount={amount}
          onAmountChange={setAmount}
          onBack={() => setStage('select-recipient')}
          policyLink={policyLinksByOwner[selectedToken.ownerAddress]}
          onConfirm={async () => {
            setSendResult({ kind: 'pending' });
            setStage('status');
            try {
              const r = await trpc.sendUnified.mutate({
                row: {
                  chain: selectedToken.chain,
                  chainId: selectedToken.chainId,
                  contractAddress: selectedToken.contractAddress,
                  mint: selectedToken.mint,
                  coinType: selectedToken.coinType,
                  decimals: selectedToken.decimals,
                  symbol: selectedToken.symbol,
                  ownerDwalletId: selectedToken.ownerDwalletId,
                },
                to: recipient,
                amount,
              });
              setSendResult({ kind: 'submitted', txid: r.txid });
            } catch (e) {
              setSendResult({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
            }
          }}
        />
      )}

      {stage === 'status' && selectedToken && sendResult && (
        <StatusStep
          token={selectedToken}
          result={sendResult}
          networks={networks}
          onClose={() => {
            setStage('select-token');
            setSelectedToken(null);
            setRecipient('');
            setAmount('');
            setSendResult(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// step 1: select coin / token
// ---------------------------------------------------------------------------

function SelectTokenStep(props: {
  onPick: (row: SendTokenRow, links: Record<string, SendPolicyLinkSnapshot>) => void;
}) {
  const [scope, setScope] = useState<SendTokenScope>('everything');
  const [networkFilter, setNetworkFilter] = useState<SendTokenNetworkFilter>('all');
  const [rows, setRows] = useState<SendTokenRow[]>([]);
  const [partial, setPartial] = useState(false);
  const [allowedCurves, setAllowedCurves] = useState<Array<'SECP256K1' | 'ED25519'>>([]);
  const [policyLinks, setPolicyLinks] = useState<Record<string, SendPolicyLinkSnapshot>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    trpc.sendTokenList
      .query({ scope, networkFilter })
      .then((r) => {
        if (cancelled) return;
        setRows(r.rows);
        setPartial(r.partial);
        setAllowedCurves(r.allowedCurves);
        setPolicyLinks(r.policyLinksByOwner);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, networkFilter]);

  const availableChains: SendTokenChain[] = useMemo(() => {
    const all: SendTokenChain[] = ['evm', 'sui', 'solana', 'btc', 'aptos'];
    if (allowedCurves.length === 0) return all;
    // SECP256K1 covers EVM + BTC; ED25519 covers Sui + Solana + Aptos.
    const has = (c: 'SECP256K1' | 'ED25519') => allowedCurves.includes(c);
    return all.filter((chain) => {
      if (chain === 'evm' || chain === 'btc') return has('SECP256K1');
      return has('ED25519');
    });
  }, [allowedCurves]);

  return (
    <>
      <h3 className="sp-sectionTitle" style={{ marginTop: 8 }}>Select Coin/Token</h3>

      <div className="sp-section" role="radiogroup" aria-label="scope">
        <div className="sp-sectionTitle">scope</div>
        <div className="sp-chipRow">
          {(['dwallet', 'vault', 'everything'] as SendTokenScope[]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scope === s}
              className={`sp-chip${scope === s ? ' sp-chipActive' : ''}`}
              onClick={() => setScope(s)}
            >
              {SCOPE_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="sp-section" role="radiogroup" aria-label="network">
        <div className="sp-sectionTitle">network</div>
        <div className="sp-chipRow">
          <button
            type="button"
            role="radio"
            aria-checked={networkFilter === 'all'}
            className={`sp-chip${networkFilter === 'all' ? ' sp-chipActive' : ''}`}
            onClick={() => setNetworkFilter('all')}
          >
            All
          </button>
          {availableChains.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={networkFilter === c}
              className={`sp-chip${networkFilter === c ? ' sp-chipActive' : ''}`}
              onClick={() => setNetworkFilter(c)}
            >
              {CHAIN_LABELS[c]}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="sp-error">{error}</div>}
      {partial && !error && (
        <div className="sp-muted" style={{ fontSize: 11, marginBottom: 8 }}>
          some balance probes failed - results may be incomplete.
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="sp-muted" style={{ fontSize: 12 }}>loading balances...</div>
      ) : rows.length === 0 ? (
        <div className="sp-muted" style={{ fontSize: 12 }}>
          no coins or tokens found in this scope.
        </div>
      ) : (
        <ul className="sp-tokenList" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                className="sp-tokenRow"
                onClick={() => props.onPick(row, policyLinks)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  textAlign: 'left',
                  padding: 10,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 6,
                  cursor: 'pointer',
                }}
              >
                <TokenIcon row={row} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600 }}>{row.symbol}</span>
                    <span className="sp-muted" style={{ fontSize: 10 }}>{row.networkLabel}</span>
                  </div>
                  <div className="sp-muted" style={{ fontSize: 11 }}>
                    {row.balanceFormatted} {row.symbol}
                    {row.pricePerTokenUsd != null
                      ? ` - ${formatUsd(row.pricePerTokenUsd)} ea`
                      : ''}
                  </div>
                  <div className="sp-muted" style={{ fontSize: 10 }}>
                    {row.ownerLabel}
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', minWidth: 80 }}>
                  {row.totalUsdValue != null ? formatUsd(row.totalUsdValue) : '-'}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function TokenIcon({ row }: { row: SendTokenRow }) {
  const fallback = row.symbol.slice(0, 2);
  if (row.iconUrl) {
    return (
      <img
        src={row.iconUrl}
        alt=""
        width={28}
        height={28}
        style={{ borderRadius: 999, background: 'rgba(255,255,255,0.06)' }}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }
  return (
    <div
      aria-hidden
      style={{
        width: 28,
        height: 28,
        borderRadius: 999,
        background: 'rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {fallback}
    </div>
  );
}

// ---------------------------------------------------------------------------
// step 2: pick recipient
// ---------------------------------------------------------------------------

function SelectRecipientStep(props: {
  token: SendTokenRow;
  recipient: string;
  onRecipientChange: (r: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [book, setBook] = useState<AddressBookEntry[]>([]);
  const [recents, setRecents] = useState<RecentRecipient[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void trpc.addressBookList.query().then((r) => setBook(r.entries)).catch(() => setBook([]));
    void trpc.recentRecipients
      .query({ chain: props.token.chain })
      .then((r) => setRecents(r.entries))
      .catch(() => setRecents([]));
  }, [props.token.chain]);

  const filteredBook = useMemo(
    () => book.filter((e) => e.chain === props.token.chain),
    [book, props.token.chain],
  );

  async function saveAddress() {
    if (!addName.trim()) {
      setAddError('Name is required');
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const entry = await trpc.addressBookAdd.mutate({
        name: addName.trim(),
        address: props.recipient.trim(),
        chain: props.token.chain,
      });
      setBook((prev) => [...prev, entry]);
      setShowAdd(false);
      setAddName('');
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  return (
    <>
      <button type="button" className="sp-backBtn" onClick={props.onBack}>
        &lt;- back
      </button>
      <h3 className="sp-sectionTitle" style={{ marginTop: 8 }}>
        Send {props.token.symbol} on {props.token.networkLabel}
      </h3>
      <div className="sp-muted" style={{ fontSize: 11, marginBottom: 8 }}>
        from {props.token.ownerLabel}
      </div>

      <div className="sp-section">
        <label className="sp-sectionTitle" htmlFor="send-recipient">recipient address</label>
        <input
          id="send-recipient"
          type="text"
          className="sp-input"
          placeholder={placeholderFor(props.token.chain)}
          value={props.recipient}
          onChange={(e) => props.onRecipientChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {props.recipient.trim().length > 0 && (
          <button
            type="button"
            className="sp-btn"
            style={{ marginTop: 6, fontSize: 11, padding: '4px 8px' }}
            onClick={() => setShowAdd(true)}
          >
            + Save to address book
          </button>
        )}
      </div>

      {showAdd && (
        <div className="sp-section">
          <label className="sp-sectionTitle" htmlFor="send-recipient-name">name for this address</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              id="send-recipient-name"
              type="text"
              className="sp-input"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="Alice"
              autoFocus
            />
            <button type="button" className="sp-btn sp-btnPrimary" disabled={adding} onClick={() => void saveAddress()}>
              {adding ? 'saving...' : 'save'}
            </button>
            <button
              type="button"
              className="sp-btn"
              onClick={() => {
                setShowAdd(false);
                setAddName('');
                setAddError(null);
              }}
            >
              <X size={14} />
            </button>
          </div>
          {addError && <div className="sp-error" style={{ marginTop: 4, fontSize: 11 }}>{addError}</div>}
        </div>
      )}

      {filteredBook.length > 0 && (
        <RecipientGroup
          title="Address book"
          rows={filteredBook.map((e) => ({ id: e.id, label: e.name, address: e.address }))}
          onPick={(addr) => props.onRecipientChange(addr)}
        />
      )}
      {recents.length > 0 && (
        <RecipientGroup
          title="Recently sent to"
          rows={recents.map((r) => ({ id: r.address, label: r.address, address: r.address }))}
          onPick={(addr) => props.onRecipientChange(addr)}
        />
      )}

      <button
        type="button"
        className="sp-btn sp-btnPrimary sp-btnFull"
        disabled={!props.recipient.trim()}
        onClick={props.onNext}
      >
        Continue
      </button>
    </>
  );
}

function placeholderFor(chain: SendTokenChain): string {
  switch (chain) {
    case 'evm':
      return '0x...';
    case 'sui':
      return '0x... (Sui address, 64 hex chars)';
    case 'solana':
      return 'base58 address';
    case 'btc':
      return 'bc1... / tb1... / 1...';
    case 'aptos':
      return '0x...';
  }
}

function RecipientGroup(props: {
  title: string;
  rows: Array<{ id: string; label: string; address: string }>;
  onPick: (address: string) => void;
}) {
  return (
    <div className="sp-section">
      <div className="sp-sectionTitle">{props.title}</div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {props.rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className="sp-btn"
              onClick={() => props.onPick(r.address)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: 8,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
              title={r.address}
            >
              <Search size={12} aria-hidden />
              <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.label}
              </span>
              <span className="sp-muted" style={{ fontSize: 10 }}>
                {shortAddress(r.address)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function shortAddress(a: string): string {
  if (a.length <= 14) return a;
  return `${a.slice(0, 6)}...${a.slice(-6)}`;
}

// ---------------------------------------------------------------------------
// step 3: confirm (amount + fee + policy gauge)
// ---------------------------------------------------------------------------

function ConfirmStep(props: {
  token: SendTokenRow;
  recipient: string;
  amount: string;
  onAmountChange: (v: string) => void;
  policyLink?: SendPolicyLinkSnapshot;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const [mode] = useSendAmountInputMode();
  const [feeEstimate, setFeeEstimate] = useState<{ feeFormatted: string; feeUsd: number | null } | null>(null);
  // future: poll a real estimateSendFee tRPC; for now we show a placeholder "network fee" line.
  useEffect(() => {
    setFeeEstimate({ feeFormatted: 'network gas (estimate at send)', feeUsd: null });
  }, [props.token, props.recipient, props.amount]);

  const policyMaxTokenAmount = useMemo(() => {
    if (!props.policyLink) return undefined;
    if (props.policyLink.panicked) return '0';
    const remainingMicros = BigInt(props.policyLink.remainingMicros);
    if (remainingMicros <= 0n) return '0';
    const pricedNatively = NATIVES_PRICED_BY_POLICY_V0.has(props.token.symbol.toUpperCase()) && !props.token.contractAddress && !props.token.mint;
    if (!pricedNatively) return undefined;
    const price = props.token.pricePerTokenUsd ?? 0;
    if (price <= 0) return undefined;
    const remainingUsd = Number(remainingMicros) / 1_000_000;
    const maxTokens = remainingUsd / price;
    return maxTokens.toFixed(Math.min(props.token.decimals, 8));
  }, [props.policyLink, props.token]);

  const policyClampApplies =
    policyMaxTokenAmount != null && Number.parseFloat(policyMaxTokenAmount) >= 0;

  const tokenAdvisoryText = (() => {
    if (!props.policyLink) return null;
    const isUnpricedToken = Boolean(props.token.contractAddress || props.token.mint);
    if (isUnpricedToken) {
      return 'Policy Vault v0 does not price tokens; the on-chain cap will not block this send.';
    }
    return null;
  })();

  const submitDisabled =
    !props.amount.trim() ||
    Number.parseFloat(props.amount) <= 0 ||
    (props.policyLink?.panicked === true);

  return (
    <>
      <button type="button" className="sp-backBtn" onClick={props.onBack}>
        &lt;- back
      </button>

      <h3 className="sp-sectionTitle" style={{ marginTop: 8 }}>Confirm send</h3>

      <div className="sp-section">
        <div className="sp-muted" style={{ fontSize: 11, marginBottom: 4 }}>from</div>
        <div style={{ fontSize: 12 }}>{props.token.ownerLabel}</div>
        <ExplorerValueRow
          fullValue={props.token.ownerAddress}
          href={null}
          truncateMid={{ head: 8, tail: 6 }}
          copyLabel="copy from address"
        />
      </div>

      <div className="sp-section">
        <div className="sp-muted" style={{ fontSize: 11, marginBottom: 4 }}>to</div>
        <ExplorerValueRow
          fullValue={props.recipient}
          href={null}
          truncateMid={{ head: 8, tail: 6 }}
          copyLabel="copy recipient"
        />
      </div>

      <AmountInputControl
        mode={mode}
        tokenSymbol={props.token.symbol}
        decimals={props.token.decimals}
        balanceMax={props.token.balanceFormatted}
        policyMaxTokenAmount={policyMaxTokenAmount}
        gasReserveAmount={gasReserveForSend(props.token)}
        pricePerTokenUsd={props.token.pricePerTokenUsd ?? null}
        value={props.amount}
        onChange={props.onAmountChange}
      />

      {tokenAdvisoryText && (
        <div className="sp-muted" style={{ fontSize: 11, marginBottom: 8 }}>
          {tokenAdvisoryText}
        </div>
      )}
      {policyClampApplies && !tokenAdvisoryText && (
        <div className="sp-muted" style={{ fontSize: 11, marginBottom: 8 }}>
          Policy Vault is clamping the maximum to {policyMaxTokenAmount} {props.token.symbol}.
        </div>
      )}

      <div className="sp-section">
        <div className="sp-muted" style={{ fontSize: 11 }}>
          {feeEstimate?.feeFormatted ?? 'estimating fee...'}
        </div>
      </div>

      {(() => {
        const btn = (
          <button
            type="button"
            className="sp-btn sp-btnPrimary sp-btnFull"
            disabled={submitDisabled || __CHROMATIKA_PREVIEW_IFRAME__}
            onClick={props.onConfirm}
          >
            {props.policyLink?.panicked ? 'Policy Vault panicked' : 'Confirm send'}
          </button>
        );
        return __CHROMATIKA_PREVIEW_IFRAME__ ? (
          <PreviewDisabledTooltip message="send - not available in live preview" layout="block">
            {btn}
          </PreviewDisabledTooltip>
        ) : (
          btn
        );
      })()}
    </>
  );
}

// ---------------------------------------------------------------------------
// step 4: status
// ---------------------------------------------------------------------------

function StatusStep(props: {
  token: SendTokenRow;
  result: { kind: 'pending' } | { kind: 'submitted'; txid: string } | { kind: 'failed'; message: string };
  networks: Networks | null;
  onClose: () => void;
}) {
  const explorerPrefs = useExplorerPreferences();
  const txid = props.result.kind === 'submitted' ? props.result.txid : null;
  const chainKey = activityChainForToken(props.token.chain);
  const href = txid && chainKey ? activityTxExplorerHref(explorerPrefs, props.networks, chainKey, txid) : null;

  return (
    <>
      <h3 className="sp-sectionTitle" style={{ marginTop: 8 }}>
        {props.result.kind === 'pending'
          ? 'Broadcasting...'
          : props.result.kind === 'submitted'
            ? 'Sent!'
            : 'Send failed'}
      </h3>

      {props.result.kind === 'pending' && (
        <div className="sp-muted" style={{ fontSize: 12 }}>
          signing via ika and broadcasting to {props.token.networkLabel}...
        </div>
      )}

      {props.result.kind === 'submitted' && txid && (
        <div className="sp-successBox">
          <div className="sp-successLabel">transaction submitted</div>
          <div className="sp-txHash">
            <ExplorerValueRow
              fullValue={txid}
              href={href}
              truncateMid={{ head: 12, tail: 8 }}
              copyLabel="copy transaction hash"
            />
          </div>
          <div className="sp-muted" style={{ fontSize: 11, marginTop: 6 }}>
            confirmation may take up to a minute. you can close this screen.
          </div>
        </div>
      )}

      {props.result.kind === 'failed' && (
        <div className="sp-error" style={{ marginBottom: 8 }}>
          {props.result.message}
        </div>
      )}

      <button type="button" className="sp-btn sp-btnFull" onClick={props.onClose}>
        Close
      </button>
    </>
  );
}

function activityChainForToken(chain: SendTokenChain): 'sui' | 'evm' | 'solana' | 'bitcoin' | null {
  switch (chain) {
    case 'evm':
      return 'evm';
    case 'sui':
      return 'sui';
    case 'solana':
      return 'solana';
    case 'btc':
      return 'bitcoin';
    case 'aptos':
      return null; // no explorer wired for Aptos sends today
  }
}

/**
 * decimal gas-reserve amount to leave behind when computing Max for a native-gas-asset send.
 * mirrors backend constants:
 *  - Sui from a dWallet's Sui address: 0.05 SUI for network gas on the send PTB
 *    (see DWALLET_SUI_GAS_RESERVE_MIST in sui-send-from-dwallet.ts).
 *  - Solana native SOL: roughly 0.00001 SOL for fee (~5000 lamports).
 *  - others: no reservation since the token being sent isn't the gas asset.
 * returns undefined when no reservation is needed (e.g. sending IKA, USDC, etc. - those don't
 * pay gas themselves, so Max can be the full balance).
 */
function gasReserveForSend(token: SendTokenRow): string | undefined {
  const isNativeSui =
    token.chain === 'sui' &&
    (token.coinType === '0x2::sui::SUI' ||
      token.coinType === '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI');
  if (isNativeSui && token.ownerDwalletId) return '0.05';
  if (token.chain === 'solana' && !token.mint && token.ownerDwalletId) return '0.0001';
  return undefined;
}
