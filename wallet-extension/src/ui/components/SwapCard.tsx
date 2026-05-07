import { useState } from 'react';
import { ikaFromBaseUnits } from '@/lib/sui-amount';
import { trpc } from '@/lib/trpc';
import type { SwapQuote } from '@/background/funding/swap-service';

type SwapStep = 'idle' | 'quoting' | 'quoted' | 'executing' | 'success' | 'error';

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return 'unknown error';
  }
}

export function SwapCard({
  onClose,
  onSwapCommitted,
  onSuccess,
}: {
  onClose: () => void;
  /** runs as soon as the swap tx succeeds (before the success dwell). refresh balances here so fuel gauges update immediately. */
  onSwapCommitted?: () => void;
  /** runs after a short success dwell; typically closes the swap panel */
  onSuccess: () => void;
}) {
  const [step, setStep] = useState<SwapStep>('idle');
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [customAmount, setCustomAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [txDigest, setTxDigest] = useState<string | null>(null);
  const [ikaReceived, setIkaReceived] = useState<string | null>(null);

  async function fetchQuote() {
    setStep('quoting');
    setError(null);
    try {
      const amountInMist = customAmount ? BigInt(Math.floor(parseFloat(customAmount) * 1e9)).toString() : undefined;
      const q = await trpc.swapQuote.query({ amountInMist, slippageBps: 100 });
      setQuote(q);
      setStep('quoted');
    } catch (e) {
      setError(errText(e));
      setStep('error');
    }
  }

  async function doSwap() {
    if (!quote) return;
    setStep('executing');
    setError(null);
    try {
      const result = await trpc.executeSwap.mutate({ quoteId: quote.id, quote });
      setTxDigest(result.txDigest);
      setIkaReceived(result.ikaReceivedBaseUnits);
      onSwapCommitted?.();
      setStep('success');
      setTimeout(onSuccess, 1500);
    } catch (e) {
      setError(errText(e));
      setStep('error');
    }
  }

  function fmtMist(mist: string): string {
    try {
      return (Number(BigInt(mist)) / 1e9).toFixed(4);
    } catch {
      return mist;
    }
  }

  /** IKA amounts from the quote are base units (9 decimals), same as on-chain balances. */
  function fmtIka(base: string): string {
    try {
      const n = ikaFromBaseUnits(base);
      if (!Number.isFinite(n)) return base;
      return n.toLocaleString(undefined, { maximumFractionDigits: 6, minimumFractionDigits: 0 });
    } catch {
      return base;
    }
  }

  return (
    <div className="sp-swapCard">
      <div className="sp-swapHeader">
        <span className="sp-swapTitle">⇄ swap SUI → IKA</span>
        <button type="button" className="sp-closeBtn" onClick={onClose}>
          ✕
        </button>
      </div>

      {step === 'idle' && (
        <div className="sp-swapBody">
          <label className="sp-swapLabel">
            SUI amount (leave blank for auto)
            <input
              type="text"
              className="sp-swapInput"
              placeholder="e.g. 0.25"
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value)}
            />
          </label>
          <button type="button" className="sp-btn sp-btnPrimary" onClick={fetchQuote}>
            get quote
          </button>
        </div>
      )}

      {step === 'quoting' && (
        <div className="sp-swapBody">
          <p className="sp-muted">fetching route from Aftermath…</p>
        </div>
      )}

      {step === 'quoted' && quote && (
        <div className="sp-swapBody">
          <div className="sp-swapQuoteRow">
            <span className="sp-swapQuoteLabel">sending</span>
            <span className="sp-swapQuoteVal">{fmtMist(quote.amountInBaseUnits)} SUI</span>
          </div>
          <div className="sp-swapQuoteRow">
            <span className="sp-swapQuoteLabel">expected</span>
            <span className="sp-swapQuoteVal">~{fmtIka(quote.expectedOutBaseUnits)} IKA</span>
          </div>
          <div className="sp-swapQuoteRow">
            <span className="sp-swapQuoteLabel">min output</span>
            <span className="sp-swapQuoteVal">{fmtIka(quote.minOutBaseUnits)} IKA</span>
          </div>
          <div className="sp-swapQuoteRow">
            <span className="sp-swapQuoteLabel">slippage</span>
            <span className="sp-swapQuoteVal">{(quote.slippageBps / 100).toFixed(1)}%</span>
          </div>
          <div className="sp-swapQuoteRow sp-swapQuoteRow--route">
            <span className="sp-swapQuoteLabel">route</span>
            <span className="sp-swapQuoteVal sp-muted sp-swapQuoteRouteVal">{quote.routeSummary}</span>
          </div>
          <div className="sp-swapActions">
            <button type="button" className="sp-btn" onClick={() => setStep('idle')}>
              back
            </button>
            <button type="button" className="sp-btn sp-btnPrimary" onClick={() => void doSwap()}>
              confirm swap
            </button>
          </div>
        </div>
      )}

      {step === 'executing' && (
        <div className="sp-swapBody">
          <p className="sp-muted">signing and broadcasting swap…</p>
        </div>
      )}

      {step === 'success' && (
        <div className="sp-swapBody">
          <div className="sp-sendSuccess">
            ✓ swap complete! received {ikaReceived ? fmtIka(ikaReceived) : '?'} IKA
          </div>
          {txDigest && <div className="sp-swapDigest">tx: {txDigest.slice(0, 16)}…</div>}
        </div>
      )}

      {step === 'error' && (
        <div className="sp-swapBody">
          <div className="sp-sendError" role="alert">
            {error ?? 'swap failed'}
          </div>
          <button
            type="button"
            className="sp-btn"
            onClick={() => {
              setError(null);
              setStep('idle');
            }}
          >
            try again
          </button>
        </div>
      )}
    </div>
  );
}
