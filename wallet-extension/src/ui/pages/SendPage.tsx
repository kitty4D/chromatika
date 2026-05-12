import { useEffect, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { suiFromMist } from '@/lib/sui-amount';
import type { Balances, Networks } from '@/ui/types';
import { HiddenTransferForm } from '@/ui/components/HiddenTransferForm';
import { PolicyVaultBanner } from '@/ui/components/PolicyVaultBanner';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import { PreviewDisabledTooltip } from '@/ui/components/PreviewDisabledTooltip';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import { buildSolanaExplorerUrl } from '@/config/explorers';
import { activityTxExplorerHref } from '@/lib/explorer-href';

type PcMarketsList = Awaited<ReturnType<typeof trpc.listPcTokenMarkets.query>>;
type PcMarket = PcMarketsList['markets'][number];

const PC_ASSET_PREFIX = 'pc:';

function amountToHex(amount: string, decimals = 18): string {
  const [intPart = '0', fracPart = ''] = amount.split('.');
  const frac = fracPart.slice(0, decimals).padEnd(decimals, '0');
  const bigVal = BigInt(intPart) * BigInt(10 ** decimals) + BigInt(frac);
  return '0x' + bigVal.toString(16);
}

/** "9N4..eU8a", keep mints recognizable in the dropdown without hogging width. */
function shortMint(mint: string): string {
  if (mint.length <= 12) return mint;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

type SolanaSplOption = {
  mint: string;
  decimals: number;
  balance: string;
  balanceRaw: string;
};

/** marker value for native SOL in the asset dropdown. kept distinct from any base58 mint. */
const SOL_NATIVE = 'native:sol';

export function SendPage({
  balances,
  networks,
  initialPcMarketId,
}: {
  balances: Balances | null;
  networks: Networks | null;
  /** when set, jump straight to the Solana hidden-transfer form for this market. */
  initialPcMarketId?: string;
}) {
  const explorerPrefs = useExplorerPreferences();
  const [chain, setChain] = useState<'sui' | 'evm' | 'btc' | 'solana'>(
    initialPcMarketId ? 'solana' : 'evm',
  );
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // solana asset selector state. fetched on demand when chain switches to solana so users on
  // EVM never pay the round-trip. asset key is one of:
  //   - SOL_NATIVE sentinel
  //   - raw SPL mint base58
  //   - `pc:${marketId}` for a configured PC-Token market (hidden transfer)
  const [solanaAsset, setSolanaAsset] = useState<string>(
    initialPcMarketId ? `${PC_ASSET_PREFIX}${initialPcMarketId}` : SOL_NATIVE,
  );
  const [solanaSplOptions, setSolanaSplOptions] = useState<SolanaSplOption[]>([]);
  const [solanaSplLoading, setSolanaSplLoading] = useState(false);
  const [solanaSplError, setSolanaSplError] = useState<string | null>(null);
  const [solanaOwner, setSolanaOwner] = useState<string | null>(null);
  const [pcMarkets, setPcMarkets] = useState<PcMarket[]>([]);

  useEffect(() => {
    if (chain !== 'solana') return;
    let cancelled = false;
    setSolanaSplLoading(true);
    setSolanaSplError(null);
    void Promise.all([
      trpc.listSolanaSplBalances.query(),
      trpc.listPcTokenMarkets.query().catch(() => ({ markets: [], activeMarketId: null })),
    ])
      .then(([spl, mkts]) => {
        if (cancelled) return;
        setSolanaSplOptions(spl.tokens);
        setSolanaOwner(spl.owner);
        setPcMarkets(mkts.markets);
      })
      .catch((e) => {
        if (cancelled) return;
        setSolanaSplError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setSolanaSplLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chain]);

  const selectedPcMarket = useMemo<PcMarket | null>(() => {
    if (chain !== 'solana' || !solanaAsset.startsWith(PC_ASSET_PREFIX)) return null;
    const id = solanaAsset.slice(PC_ASSET_PREFIX.length);
    return pcMarkets.find((m) => m.id === id) ?? null;
  }, [chain, solanaAsset, pcMarkets]);

  const chainId = networks?.active?.evmChainId ?? 1;
  const evmSymbol = networks?.evm.find((n) => n.chainId === chainId)?.symbol ?? 'ETH';
  const selectedSpl =
    chain === 'solana' && solanaAsset !== SOL_NATIVE
      ? solanaSplOptions.find((t) => t.mint === solanaAsset) ?? null
      : null;
  const symbol =
    chain === 'evm'
      ? evmSymbol
      : chain === 'btc'
        ? 'BTC'
        : chain === 'solana'
          ? selectedSpl
            ? shortMint(selectedSpl.mint)
            : 'SOL'
          : 'SUI';

  async function onSend() {
    setError(null);
    setTxHash(null);
    if (!toAddress.trim()) {
      setError('enter a destination address');
      return;
    }
    if (!amount.trim() || Number(amount) <= 0) {
      setError('enter an amount greater than zero');
      return;
    }

    setSending(true);
    try {
      if (chain === 'evm') {
        const value = amountToHex(amount, networks?.evm.find((n) => n.chainId === chainId)?.decimals ?? 18);
        const r = await trpc.sendEvmTx.mutate({ to: toAddress.trim(), value });
        setTxHash(r.txHash);
        setToAddress('');
        setAmount('');
      } else if (chain === 'sui') {
        const r = await trpc.sendSuiNative.mutate({ to: toAddress.trim(), amountSui: amount.trim() });
        setTxHash(r.digest);
        setToAddress('');
        setAmount('');
      } else if (chain === 'solana') {
        if (selectedSpl) {
          const r = await trpc.sendSplToken.mutate({
            to: toAddress.trim(),
            mint: selectedSpl.mint,
            amount: amount.trim(),
            decimals: selectedSpl.decimals,
          });
          setTxHash(r.signature);
        } else {
          const r = await trpc.sendSolanaNative.mutate({
            to: toAddress.trim(),
            amountSol: amount.trim(),
          });
          setTxHash(r.signature);
        }
        setToAddress('');
        setAmount('');
      } else if (chain === 'btc') {
        const r = await trpc.sendBtcNative.mutate({ to: toAddress.trim(), amountBtc: amount.trim() });
        setTxHash(r.txid);
        setToAddress('');
        setAmount('');
      } else {
        setError(`${chain} send coming soon — evm, sui, solana, and btc are live`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="sp-page">
      <h2 className="sp-pageTitle">send</h2>

      <PolicyVaultBanner />

      <div className="sp-section" role="radiogroup" aria-label="select chain to send on">
        <div className="sp-sectionTitle">chain</div>
        <div className="sp-chipRow">
          {(['evm', 'sui', 'btc', 'solana'] as const).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={chain === c}
              className={`sp-chip${chain === c ? ' sp-chipActive' : ''}`}
              onClick={() => {
                setChain(c);
                setSolanaAsset(SOL_NATIVE);
                setError(null);
                setTxHash(null);
              }}
            >
              {c === 'evm' ? `evm (${chainId})` : c}
            </button>
          ))}
        </div>
      </div>

      {chain === 'solana' && (
        <div className="sp-section">
          <label className="sp-sectionTitle" htmlFor="send-solana-asset">asset</label>
          <select
            id="send-solana-asset"
            className="sp-input"
            value={solanaAsset}
            onChange={(e) => {
              setSolanaAsset(e.target.value);
              setError(null);
              setTxHash(null);
            }}
            disabled={solanaSplLoading}
            aria-label="select Solana asset to send"
          >
            <option value={SOL_NATIVE}>SOL (native)</option>
            {solanaSplOptions.map((t) => (
              <option key={t.mint} value={t.mint}>
                {shortMint(t.mint)} — {t.balance}
              </option>
            ))}
            {pcMarkets.length > 0 &&
              pcMarkets.map((m) => (
                <option key={`pc:${m.id}`} value={`${PC_ASSET_PREFIX}${m.id}`}>
                  🔒 pc{m.splSymbol} ({m.label}) — hidden
                </option>
              ))}
          </select>
          {solanaSplLoading && (
            <div className="sp-muted" style={{ fontSize: 11, marginTop: 4 }}>
              loading solana holdings…
            </div>
          )}
          {solanaSplError && (
            <div className="sp-error" style={{ fontSize: 11, marginTop: 4 }}>
              could not load SPL holdings: {solanaSplError}
            </div>
          )}
          {!solanaSplLoading && !solanaSplError && solanaSplOptions.length === 0 && pcMarkets.length === 0 && (
            <div className="sp-muted" style={{ fontSize: 11, marginTop: 4 }}>
              no SPL token holdings at this address
            </div>
          )}
          {selectedSpl && (
            <div className="sp-muted" style={{ fontSize: 11, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>mint:</span>
              <ExplorerValueRow
                fullValue={selectedSpl.mint}
                href={buildSolanaExplorerUrl(explorerPrefs, networks?.active.solNetworkId ?? 'sol-devnet', 'address', selectedSpl.mint)}
                truncateMid={{ head: 6, tail: 6 }}
                copyLabel="copy mint address"
              />
            </div>
          )}
          {solanaOwner && (
            <div className="sp-muted" style={{ fontSize: 11, marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>from:</span>
              <ExplorerValueRow
                fullValue={solanaOwner}
                href={buildSolanaExplorerUrl(explorerPrefs, networks?.active.solNetworkId ?? 'sol-devnet', 'address', solanaOwner)}
                truncateMid={{ head: 6, tail: 6 }}
                copyLabel="copy sender address"
              />
            </div>
          )}
        </div>
      )}

      {selectedPcMarket && (
        <HiddenTransferForm
          marketId={selectedPcMarket.id}
          marketLabel={selectedPcMarket.label}
          splSymbol={selectedPcMarket.splSymbol}
          splDecimals={selectedPcMarket.splDecimals}
          onSent={(sig) => setTxHash(sig)}
        />
      )}

      {!selectedPcMarket && (
        <>
          <div className="sp-section">
            <label className="sp-sectionTitle" htmlFor="send-to-address">to address</label>
            <input
              id="send-to-address"
              type="text"
              className="sp-input"
              placeholder={
                chain === 'btc'
                  ? 'bc1q…'
                  : chain === 'solana'
                    ? 'base58…'
                    : chain === 'sui'
                      ? '0x… (Sui address)'
                      : '0x…'
              }
              value={toAddress}
              onChange={(e) => setToAddress(e.target.value)}
              aria-label={`recipient ${chain} address`}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="sp-section">
            <label className="sp-sectionTitle" htmlFor="send-amount">amount</label>
            <div className="sp-amountRow">
              <input
                id="send-amount"
                type="number"
                className="sp-input sp-inputAmount"
                placeholder="0.00"
                min="0"
                value={amount}
                aria-label="send amount"
                inputMode="decimal"
                onChange={(e) => setAmount(e.target.value)}
              />
              <span className="sp-amountUnit">{symbol}</span>
            </div>
            {balances && !balances.locked && (
              <div className="sp-muted" style={{ fontSize: 11, marginTop: 4 }}>
                balance:{' '}
                {chain === 'sui'
                  ? `${suiFromMist(balances.sui).toFixed(4)} SUI (fee address)`
                  : chain === 'evm'
                    ? 'see token list'
                    : chain === 'solana' && selectedSpl
                      ? `${selectedSpl.balance} (raw ${selectedSpl.balanceRaw})`
                      : '—'}
              </div>
            )}
          </div>

          {error && <div className="sp-error">{error}</div>}

          {txHash && (
            <div className="sp-successBox">
              <div className="sp-successLabel">sent!</div>
              <div className="sp-txHash">
                <ExplorerValueRow
                  fullValue={txHash}
                  href={activityTxExplorerHref(
                    explorerPrefs,
                    networks,
                    chain === 'btc' ? 'bitcoin' : chain,
                    txHash,
                  )}
                  truncateMid={{ head: 12, tail: 8 }}
                  copyLabel="copy transaction hash"
                />
              </div>
            </div>
          )}

          {(() => {
            const sendCtaLocked =
              sending
              || (chain !== 'evm' && chain !== 'sui' && chain !== 'solana' && chain !== 'btc')
              || __CHROMATIKA_PREVIEW_IFRAME__;
            const label = sending
              ? chain === 'sui'
                ? 'signing…'
                : chain === 'btc'
                  ? 'signing BTC via ika…'
                  : 'signing via ika…'
              : chain === 'evm'
                ? 'review & send'
                : chain === 'sui'
                  ? 'send SUI'
                  : chain === 'solana'
                    ? selectedSpl
                      ? `send ${shortMint(selectedSpl.mint)}`
                      : 'send SOL'
                    : chain === 'btc'
                      ? 'send BTC'
                      : `${chain} send coming soon`;
            const btn = (
              <button
                type="button"
                className="sp-btn sp-btnPrimary sp-btnFull"
                disabled={sendCtaLocked}
                onClick={onSend}
              >
                {label}
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
      )}
    </div>
  );
}
