import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Interface, isAddress, parseUnits } from 'ethers';
import { ArrowUpRight, Lock, ArrowDownToLine, ArrowUpFromLine, Send } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { evmTxExplorerUrl } from '@/lib/explorer-href';
import { formatUsd } from '@/lib/sui-amount';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';

export type EvmTokenRow = {
  contractAddress: string | null;
  symbol: string;
  name: string;
  balanceFormatted: string;
  usdValue: number | null;
  /** defaults to 18 when missing (e.g. legacy callers). */
  decimals?: number;
};

export type NativeAssetRow = {
  rowKey?: string;
  symbol: string;
  name: string;
  balanceFormatted: string;
  usdValue: number | null;
};

/**
 * a Solana SPL token row. when `eligibleMarketIds` is non-empty, the row gets a Wrap action that
 * opens `WrapPcTokenModal` for one of the configured PC-Token markets.
 */
export type SolanaSplRow = {
  rowKey?: string;
  mint: string;
  symbol: string;
  balanceFormatted: string;
  balanceRaw: string;
  decimals: number;
  /** PC-Token markets that wrap this mint. */
  eligibleMarketIds: string[];
};

/**
 * a pcToken row, encrypted balance backed by a registered PC-Token market. always rendered when
 * the market is configured; dimmed when the cached balance is zero. send + unwrap actions lift
 * to the page-level callbacks below.
 */
export type PcTokenAssetRow = {
  rowKey?: string;
  marketId: string;
  marketLabel: string;
  splSymbol: string;
  splDecimals: number;
  balanceBaseUnits: string | null;
  isZero: boolean;
};

export type PortfolioInlineSendConfig = {
  /** required when an EVM token row is present (EVM inline form needs it for the contract call). */
  evmChainId?: number;
  /** active EVM network explorer base URL (for post-send tx link). */
  evmExplorerBaseUrl?: string;
  evmNativeDecimals?: number;
  evmNativeSymbol?: string;
  expandedKey: string | null;
  onToggleSend: (rowKey: string) => void;
  onSent?: () => void;
  onOpenSend?: () => void;
};

export type PortfolioPcTokenConfig = {
  /** open the Wrap modal for the chosen market and SPL row. */
  onWrap: (args: { marketId: string; splSymbol: string; splDecimals: number }) => void;
  /** open the Send page (or pre-selected hidden-transfer flow) for this pcToken market. */
  onSendPcToken: (marketId: string) => void;
  /** open the Unwrap modal for this pcToken market. */
  onUnwrap: (marketId: string) => void;
  /** refresh decrypted balance for this market. */
  onDecrypt: (marketId: string) => void;
  /** per-market "decrypt in progress" flag for UI spinner. */
  decrypting?: Record<string, boolean>;
};

type Row =
  | { kind: 'evm'; key: string; evm: EvmTokenRow }
  | { kind: 'native'; key: string; native: NativeAssetRow; isBtc: boolean }
  | { kind: 'spl'; key: string; spl: SolanaSplRow }
  | { kind: 'pcToken'; key: string; pcToken: PcTokenAssetRow };

function shortMintInline(mint: string): string {
  if (mint.length <= 12) return mint;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function parseBalanceAmount(formatted: string): number {
  const n = Number.parseFloat(String(formatted).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function rowHasPositiveBalance(row: Row): boolean {
  if (row.kind === 'evm') return parseBalanceAmount(row.evm.balanceFormatted) > 0;
  if (row.kind === 'spl') return parseBalanceAmount(row.spl.balanceFormatted) > 0;
  if (row.kind === 'pcToken') return !row.pcToken.isZero;
  return parseBalanceAmount(row.native.balanceFormatted) > 0;
}

function rowSymbol(row: Row): string {
  if (row.kind === 'evm') return row.evm.symbol;
  if (row.kind === 'spl') return row.spl.symbol;
  if (row.kind === 'pcToken') return `pc${row.pcToken.splSymbol}`;
  return row.native.symbol;
}

function quickSendPayload(row: Row): PortfolioQuickSendRow {
  if (row.kind === 'evm') return { kind: 'evm', evm: row.evm };
  if (row.kind === 'spl') return { kind: 'spl', spl: row.spl };
  if (row.kind === 'pcToken') return { kind: 'pcToken', pcToken: row.pcToken };
  return { kind: 'native', native: row.native, isBtc: row.isBtc };
}

function formatPcBaseUnits(baseUnits: string | null, decimals: number): string {
  if (baseUnits == null) return '—';
  if (baseUnits === '0') return '0';
  const padded = baseUnits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function PortfolioInlineEvmSendForm({
  chainId,
  evmExplorerBaseUrl,
  contractAddress,
  symbol,
  decimals,
  onSuccess,
}: {
  chainId: number;
  evmExplorerBaseUrl?: string;
  contractAddress: string | null;
  symbol: string;
  decimals: number;
  onSuccess: () => void;
}) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    setTxHash(null);
    const dest = to.trim();
    if (!dest) {
      setErr('enter a destination address');
      return;
    }
    if (!isAddress(dest)) {
      setErr('invalid evm address');
      return;
    }
    if (!amount.trim() || Number(amount) <= 0) {
      setErr('enter an amount greater than zero');
      return;
    }

    setSending(true);
    try {
      if (contractAddress == null) {
        const wei = parseUnits(amount.trim(), decimals);
        const r = await trpc.sendEvmTx.mutate({
          to: dest,
          value: '0x' + wei.toString(16),
          data: '0x',
          chainId,
        });
        setTxHash(r.txHash);
      } else {
        const iface = new Interface(['function transfer(address to, uint256 amount)']);
        const valueWei = parseUnits(amount.trim(), decimals);
        const data = iface.encodeFunctionData('transfer', [dest, valueWei]);
        const r = await trpc.sendEvmTx.mutate({
          to: contractAddress,
          value: '0x0',
          data,
          chainId,
        });
        setTxHash(r.txHash);
      }
      setTo('');
      setAmount('');
      onSuccess();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="cp-tokenTableSendPanelInner">
      <div className="sp-section" style={{ marginBottom: 0 }}>
        <div className="sp-sectionTitle">to</div>
        <input
          type="text"
          className="sp-input"
          placeholder="0x…"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          disabled={sending}
        />
      </div>
      <div className="sp-section" style={{ marginBottom: 0 }}>
        <div className="sp-sectionTitle">amount ({symbol})</div>
        <input
          type="text"
          inputMode="decimal"
          className="sp-input sp-inputAmount"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={sending}
        />
      </div>
      {err ? <div className="sp-error" style={{ fontSize: 11 }}>{err}</div> : null}
      {txHash ? (
        <div style={{ marginTop: 6 }}>
          <div className="sp-muted" style={{ fontSize: 10, marginBottom: 4 }}>
            sent
          </div>
          <ExplorerValueRow
            fullValue={txHash}
            href={evmTxExplorerUrl(evmExplorerBaseUrl, txHash)}
            truncateMid={{ head: 10, tail: 8 }}
            copyLabel="Copy transaction hash"
          />
        </div>
      ) : null}
      <button type="button" className="sp-btn sp-btnPrimary" style={{ width: '100%', marginTop: 8 }} disabled={sending} onClick={() => void submit()}>
        {sending ? 'sending…' : 'confirm send'}
      </button>
    </div>
  );
}

function PortfolioInlineBtcStub({ onOpenSend }: { onOpenSend?: () => void }) {
  return (
    <div className="cp-tokenTableSendPanelInner">
      <p className="sp-muted" style={{ fontSize: 11, lineHeight: 1.45, margin: 0 }}>
        bitcoin send from this list is not wired yet. use the main send tab when we ship btc transfers here.
      </p>
      {onOpenSend ? (
        <button type="button" className="sp-btn sp-btnPrimary" style={{ width: '100%', marginTop: 10 }} onClick={onOpenSend}>
          open send
        </button>
      ) : null}
    </div>
  );
}

function portfolioExpandedSendContent(row: Row, inlineSend: PortfolioInlineSendConfig) {
  if (row.kind === 'evm' && inlineSend.evmChainId != null) {
    return (
      <PortfolioInlineEvmSendForm
        chainId={inlineSend.evmChainId}
        evmExplorerBaseUrl={inlineSend.evmExplorerBaseUrl}
        contractAddress={row.evm.contractAddress}
        symbol={row.evm.symbol}
        decimals={row.evm.decimals ?? 18}
        onSuccess={() => {
          inlineSend.onSent?.();
        }}
      />
    );
  }
  if (row.kind === 'native' && row.isBtc) {
    return <PortfolioInlineBtcStub onOpenSend={inlineSend.onOpenSend} />;
  }
  return (
    <div className="cp-tokenTableSendPanelInner">
      <p className="sp-muted" style={{ fontSize: 11, margin: 0 }}>
        send for this asset from the portfolio list is not available — use the main send tab.
      </p>
      {inlineSend.onOpenSend ? (
        <button type="button" className="sp-btn" style={{ width: '100%', marginTop: 10 }} onClick={inlineSend.onOpenSend}>
          open send
        </button>
      ) : null}
    </div>
  );
}

/**
 * unified per-row Send-icon callback. when provided, every positive-balance row gets a small
 * Send icon that bypasses the legacy `inlineSend` EVM expander and instead routes the row to
 * the parent (typically `MainWalletShell.openSendForRow`) for jumping into the multi-step Send
 * flow. variant-specific routing (EVM token vs native vs SPL vs pcToken) is the parent's job;
 * pcToken rows still surface their dedicated hidden-transfer button alongside.
 */
export type PortfolioQuickSendRow =
  | { kind: 'evm'; evm: EvmTokenRow }
  | { kind: 'native'; native: NativeAssetRow; isBtc: boolean }
  | { kind: 'spl'; spl: SolanaSplRow }
  | { kind: 'pcToken'; pcToken: PcTokenAssetRow };

export function PortfolioAssetTable({
  evmTokens,
  nativeRows,
  splRows,
  pcTokenRows,
  pcTokenConfig,
  loading,
  error,
  emptyHint,
  inlineSend,
  hideSendWhenZeroBalance,
  onQuickSend,
}: {
  evmTokens?: EvmTokenRow[];
  nativeRows?: NativeAssetRow[];
  /** Solana SPL token rows (e.g. devnet USDC). render with a Wrap action when in `eligibleMarketIds`. */
  splRows?: SolanaSplRow[];
  /** per-market pcToken synthetic rows, always shown when the market is configured. */
  pcTokenRows?: PcTokenAssetRow[];
  /** wrap/send/unwrap callbacks. required when `splRows` or `pcTokenRows` are passed. */
  pcTokenConfig?: PortfolioPcTokenConfig;
  loading?: boolean;
  error?: string | null;
  emptyHint?: string;
  inlineSend?: PortfolioInlineSendConfig;
  /** when set with `inlineSend`, omit send affordance for zero-balance rows. */
  hideSendWhenZeroBalance?: boolean;
  /** new quick-send: jump straight to the Send tab's Recipient step with the row preselected. */
  onQuickSend?: (row: PortfolioQuickSendRow) => void;
}) {
  const evmChain = inlineSend?.evmChainId;
  const rows = useMemo((): Row[] => {
    const out: Row[] = [];
    if (nativeRows?.length) {
      let i = 0;
      for (const n of nativeRows) {
        const key = n.rowKey ?? `${n.symbol}-${i}`;
        const isBtc = key.startsWith('btcP2wpkh:') || key.startsWith('btcP2tr:');
        out.push({ kind: 'native', key, native: n, isBtc });
        i += 1;
      }
    }
    if (splRows?.length) {
      let i = 0;
      for (const s of splRows) {
        const key = s.rowKey ?? `spl:${s.mint}-${i}`;
        out.push({ kind: 'spl', key, spl: s });
        i += 1;
      }
    }
    if (pcTokenRows?.length) {
      let i = 0;
      for (const p of pcTokenRows) {
        const key = p.rowKey ?? `pc:${p.marketId}-${i}`;
        out.push({ kind: 'pcToken', key, pcToken: p });
        i += 1;
      }
    }
    if (evmTokens?.length && evmChain != null) {
      for (const t of evmTokens) {
        const key = `${evmChain}:${t.contractAddress ?? 'native'}`;
        out.push({ kind: 'evm', key, evm: t });
      }
    } else if (evmTokens?.length && evmChain == null) {
      for (const t of evmTokens) {
        const key = t.contractAddress ?? 'native';
        out.push({ kind: 'evm', key, evm: t });
      }
    }
    return out;
  }, [nativeRows, evmTokens, evmChain, splRows, pcTokenRows]);

  const rowClass = inlineSend ? 'cp-tokenTableRow cp-tokenTableRow--send' : 'cp-tokenTableRow';
  const showSendForRow = (row: Row) =>
    inlineSend && (!hideSendWhenZeroBalance || rowHasPositiveBalance(row));
  const reduceMotion = useReducedMotion();
  const rowEase = [0.22, 1, 0.36, 1] as const;
  /** long lists: skip per-row framer instances + unbounded stagger delays (i * delay gets expensive past ~20 rows). */
  const skipRowEntranceMotion = reduceMotion || rows.length > 22;

  return (
    <div className="cp-tokenTable">
      {error ? <div className="sp-error" style={{ padding: '8px 0' }}>{error}</div> : null}
      {loading && !error ? <div className="sp-muted">loading balances…</div> : null}
      {!loading &&
        !error &&
        rows.map((row, i) => {
          const rowDimmed = row.kind === 'pcToken' && row.pcToken.isZero;
          const rowMain = (
            <>
              {row.kind === 'evm' ? (
                <>
                  <div className="cp-tokSym">{row.evm.symbol}</div>
                  <div className="cp-tokName">{row.evm.name}</div>
                  <div className="cp-tokBal">{Number.parseFloat(row.evm.balanceFormatted).toFixed(6)}</div>
                  <div className="cp-tokUsd">{row.evm.usdValue != null ? formatUsd(row.evm.usdValue) : '—'}</div>
                </>
              ) : row.kind === 'spl' ? (
                <>
                  <div className="cp-tokSym">{row.spl.symbol}</div>
                  <div className="cp-tokName">SPL · {shortMintInline(row.spl.mint)}</div>
                  <div className="cp-tokBal">{row.spl.balanceFormatted}</div>
                  <div className="cp-tokUsd">—</div>
                </>
              ) : row.kind === 'pcToken' ? (
                <>
                  <div className="cp-tokSym" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Lock size={11} aria-hidden /> pc{row.pcToken.splSymbol}
                  </div>
                  <div className="cp-tokName">{row.pcToken.marketLabel}</div>
                  <div className="cp-tokBal">
                    {row.pcToken.balanceBaseUnits != null
                      ? formatPcBaseUnits(row.pcToken.balanceBaseUnits, row.pcToken.splDecimals)
                      : '—'}
                  </div>
                  <div className="cp-tokUsd">—</div>
                </>
              ) : (
                <>
                  <div className="cp-tokSym">{row.native.symbol}</div>
                  <div className="cp-tokName">{row.native.name}</div>
                  <div className="cp-tokBal">{row.native.balanceFormatted}</div>
                  <div className="cp-tokUsd">{row.native.usdValue != null ? formatUsd(row.native.usdValue) : '—'}</div>
                </>
              )}
              {onQuickSend && rowHasPositiveBalance(row) ? (
                <button
                  type="button"
                  className="ch-copyIconBtn ch-copyIconBtn--12"
                  aria-label={`send ${rowSymbol(row)}`}
                  title={`send ${rowSymbol(row)}`}
                  onClick={() => onQuickSend(quickSendPayload(row))}
                >
                  <Send size={14} strokeWidth={2.25} />
                </button>
              ) : null}
              {row.kind === 'spl' && pcTokenConfig && row.spl.eligibleMarketIds.length > 0 ? (
                <button
                  type="button"
                  className="ch-copyIconBtn ch-copyIconBtn--12"
                  aria-label={`wrap ${row.spl.symbol}`}
                  title={`wrap to pc${row.spl.symbol}`}
                  onClick={() =>
                    pcTokenConfig.onWrap({
                      marketId: row.spl.eligibleMarketIds[0]!,
                      splSymbol: row.spl.symbol,
                      splDecimals: row.spl.decimals,
                    })
                  }
                >
                  <ArrowDownToLine size={14} strokeWidth={2.25} />
                </button>
              ) : row.kind === 'pcToken' && pcTokenConfig ? (
                <span style={{ display: 'inline-flex', gap: 4 }}>
                  {!row.pcToken.isZero && (
                    <button
                      type="button"
                      className="ch-copyIconBtn ch-copyIconBtn--12"
                      aria-label="send hidden"
                      title="send hidden"
                      onClick={() => pcTokenConfig.onSendPcToken(row.pcToken.marketId)}
                    >
                      <ArrowUpRight size={14} strokeWidth={2.25} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="ch-copyIconBtn ch-copyIconBtn--12"
                    aria-label="unwrap"
                    title="unwrap to SPL"
                    onClick={() => pcTokenConfig.onUnwrap(row.pcToken.marketId)}
                    disabled={row.pcToken.isZero}
                  >
                    <ArrowUpFromLine size={14} strokeWidth={2.25} />
                  </button>
                </span>
              ) : inlineSend && !onQuickSend ? (
                showSendForRow(row) ? (
                  <button
                    type="button"
                    className={`ch-copyIconBtn ch-copyIconBtn--12${inlineSend.expandedKey === row.key ? ' cp-tokenSendBtn--open' : ''}`}
                    aria-label={inlineSend.expandedKey === row.key ? 'close send' : 'send'}
                    aria-expanded={inlineSend.expandedKey === row.key}
                    onClick={() => inlineSend.onToggleSend(row.key)}
                  >
                    <ArrowUpRight size={14} strokeWidth={2.25} />
                  </button>
                ) : (
                  <span className="cp-tokSendPlaceholder" aria-hidden />
                )
              ) : null}
            </>
          );

          const dimStyle = rowDimmed ? { opacity: 0.5 } : undefined;
          return (
          <div key={row.key} className="cp-tokenTableBlock" style={dimStyle}>
            {skipRowEntranceMotion ? (
              <div className={rowClass}>{rowMain}</div>
            ) : (
              <motion.div
                className={rowClass}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  delay: Math.min(i, 14) * 0.028,
                  duration: 0.22,
                  ease: rowEase,
                }}
              >
                {rowMain}
              </motion.div>
            )}
            {inlineSend && inlineSend.expandedKey === row.key && showSendForRow(row) ? (
              reduceMotion ? (
                <div className="cp-tokenTableSendPanel">{portfolioExpandedSendContent(row, inlineSend)}</div>
              ) : (
                <motion.div
                  className="cp-tokenTableSendPanel"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.18, ease: rowEase }}
                >
                  {portfolioExpandedSendContent(row, inlineSend)}
                </motion.div>
              )
            ) : null}
          </div>
          );
        })}
      {!loading && !error && rows.length === 0 && emptyHint ? (
        <p className="sp-muted" style={{ fontSize: 12, marginTop: 8 }}>
          {emptyHint}
        </p>
      ) : null}
    </div>
  );
}
