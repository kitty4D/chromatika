/**
 * modal for unwrapping a pcToken back to the underlying SPL on a specific market. drives the
 * 3-step `pcTokenUnwrapStep` orchestration (burn -> wait for executor -> complete) with progress
 * indicators. triggered from the Unwrap button on a pcToken row in the Portfolio asset table.
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowUpFromLine, Lock, Loader2, Check, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';

type Phase = 'input' | 'burning' | 'decrypting' | 'completing' | 'done' | 'error';

function decimalToBaseUnits(decimal: string, decimals: number): string {
  const t = decimal.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error('amount must be a positive decimal');
  const [whole, frac = ''] = t.split('.');
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded)).toString();
}

export function UnwrapPcTokenModal({
  marketId,
  marketLabel,
  splSymbol,
  splDecimals,
  defaultAmount,
  onClose,
  onSuccess,
}: {
  marketId: string;
  marketLabel: string;
  splSymbol: string;
  splDecimals: number;
  defaultAmount?: string;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const [amount, setAmount] = useState(defaultAmount ?? '1');
  const [phase, setPhase] = useState<Phase>('input');
  const [err, setErr] = useState<string | null>(null);
  const [burnSignature, setBurnSignature] = useState<string | null>(null);
  const [completeSignature, setCompleteSignature] = useState<string | null>(null);
  // persist burn-step ctx between phases so the wait + complete steps can pass it back to the SW.
  const burnCtxRef = useRef<{ burnedCt: string; requestAcct: string } | null>(null);

  // step 1: burn
  async function startUnwrap() {
    setErr(null);
    let baseUnits: string;
    try {
      baseUnits = decimalToBaseUnits(amount, splDecimals);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return;
    }
    if (BigInt(baseUnits) <= 0n) {
      setErr('amount must be positive');
      return;
    }
    setPhase('burning');
    try {
      const r = await trpc.pcTokenUnwrapStep.mutate({
        phase: 'burn',
        marketId,
        amountBaseUnits: baseUnits,
      });
      // burn step returns: { step: 'burn', signature, decryptRequestB58 }. we don't yet have the
      // burnedCt pubkey from step 1's return shape; chromatika v0 derives it from the burn tx
      // event. for now the orchestrator regenerates a fresh requestAcct and we use that pubkey
      // only, burnedCt is read on-chain by the executor.
      // per pc-token-flows.ts:399, step 1 returns `{ step, signature, decryptRequestB58 }`.
      // step 3's `complete` ix needs (burnedCt, requestAcct). the wallet currently doesn't have
      // a way to recover burnedCt from the burn tx, so unwrap is partially wired.
      const result = r as unknown as { signature: string; decryptRequestB58: string; burnedCtB58?: string };
      setBurnSignature(result.signature);
      // for the v0 wiring, burnedCt is the same as the dummy used in the burn tx, kept here as a
      // placeholder; the executor lookup happens via the request account.
      burnCtxRef.current = {
        burnedCt: result.burnedCtB58 ?? result.decryptRequestB58,
        requestAcct: result.decryptRequestB58,
      };
      setPhase('decrypting');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }

  // step 2: wait for executor to commit decryption
  useEffect(() => {
    if (phase !== 'decrypting' || !burnCtxRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        await trpc.pcTokenUnwrapStep.mutate({
          phase: 'decrypt-wait',
          marketId,
          burnedCt: burnCtxRef.current!.burnedCt,
          requestAcct: burnCtxRef.current!.requestAcct,
        });
        if (cancelled) return;
        setPhase('completing');
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, marketId]);

  // step 3: complete
  useEffect(() => {
    if (phase !== 'completing' || !burnCtxRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const baseUnits = decimalToBaseUnits(amount, splDecimals);
        const r = await trpc.pcTokenUnwrapStep.mutate({
          phase: 'complete',
          marketId,
          burnedCt: burnCtxRef.current!.burnedCt,
          requestAcct: burnCtxRef.current!.requestAcct,
          amountBaseUnits: baseUnits,
        });
        if (cancelled) return;
        const result = r as unknown as { signature: string };
        setCompleteSignature(result.signature);
        setPhase('done');
        onSuccess?.();
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, marketId, amount, splDecimals, onSuccess]);

  const isFlowing = phase === 'burning' || phase === 'decrypting' || phase === 'completing';

  // Escape-to-close for keyboard users; ignored during multi-phase flow so users can't kill mid-sign.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isFlowing) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, isFlowing]);

  return (
    <div
      className="ch-bottomSheet-backdrop"
      role="presentation"
      onClick={(e) => {
        if (isFlowing) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="ch-bottomSheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unwrap-pctoken-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ch-bottomSheet-head">
          <span id="unwrap-pctoken-title" className="ch-bottomSheet-title">
            <ArrowUpFromLine size={16} /> unwrap → {splSymbol}
          </span>
          {!isFlowing && (
            <button
              type="button"
              onClick={onClose}
              className="ch-bottomSheet-close"
              aria-label="close"
            >
              ×
            </button>
          )}
        </div>
        <p className="sp-muted" style={{ fontSize: 11, lineHeight: 1.45 }}>
          Unwrapping releases {splSymbol} from {marketLabel}. Three on-chain steps: burn the
          pcToken, wait for the executor to decrypt the burn amount (3-60s on devnet), then
          release the SPL to your ATA.
        </p>

        {phase === 'input' && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              <span className="sp-muted" style={{ fontSize: 10 }}>amount ({splSymbol})</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  inputMode="decimal"
                  className="sp-input"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  style={{ flex: 1, fontSize: 13 }}
                  autoFocus
                />
                <span className="sp-muted" style={{ alignSelf: 'center', fontSize: 11 }}>pc{splSymbol}</span>
              </div>
            </div>
            {err && <div className="sp-error" style={{ marginTop: 6, fontSize: 11 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
              <button type="button" className="sp-btn" onClick={onClose} style={{ flex: 1 }}>
                cancel
              </button>
              <button
                type="button"
                className="sp-btn sp-btn--primary"
                onClick={() => void startUnwrap()}
                style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
              >
                <Lock size={12} /> unwrap
              </button>
            </div>
          </>
        )}

        {(isFlowing || phase === 'done' || phase === 'error') && (
          <ol style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <StepRow
              label="1. burn pcToken on chain"
              state={
                phase === 'burning'
                  ? 'busy'
                  : burnSignature
                    ? 'done'
                    : phase === 'error' && !burnSignature
                      ? 'error'
                      : 'pending'
              }
              detail={burnSignature ? `${burnSignature.slice(0, 10)}…` : undefined}
            />
            <StepRow
              label="2. wait for executor decrypt (3-60s)"
              state={
                phase === 'decrypting'
                  ? 'busy'
                  : phase === 'completing' || phase === 'done'
                    ? 'done'
                    : phase === 'error' && burnSignature && !completeSignature
                      ? 'error'
                      : 'pending'
              }
            />
            <StepRow
              label="3. release SPL to your ATA"
              state={
                phase === 'completing'
                  ? 'busy'
                  : completeSignature
                    ? 'done'
                    : phase === 'error' && burnSignature
                      ? 'error'
                      : 'pending'
              }
              detail={completeSignature ? `${completeSignature.slice(0, 10)}…` : undefined}
            />
          </ol>
        )}

        {phase === 'error' && err && (
          <div className="sp-error" style={{ marginTop: 8, fontSize: 11 }}>
            {err}
          </div>
        )}

        {phase === 'done' && (
          <button
            type="button"
            className="sp-btn sp-btn--primary"
            onClick={onClose}
            style={{ width: '100%', marginTop: 12 }}
          >
            done
          </button>
        )}

        {phase === 'error' && (
          <button
            type="button"
            className="sp-btn"
            onClick={onClose}
            style={{ width: '100%', marginTop: 8 }}
          >
            close
          </button>
        )}
      </div>
    </div>
  );
}

function StepRow({
  label,
  state,
  detail,
}: {
  label: string;
  state: 'pending' | 'busy' | 'done' | 'error';
  detail?: string;
}) {
  const icon =
    state === 'busy' ? (
      <Loader2 size={12} className="sp-spin" />
    ) : state === 'done' ? (
      <Check size={12} style={{ color: '#86efac' }} />
    ) : state === 'error' ? (
      <X size={12} style={{ color: '#fca5a5' }} />
    ) : (
      <span style={{ display: 'inline-block', width: 12 }} />
    );
  const opacity = state === 'pending' ? 0.4 : 1;
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: 8, opacity, fontSize: 12 }}>
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {detail && (
        <code className="sp-muted" style={{ fontSize: 10 }}>
          {detail}
        </code>
      )}
    </li>
  );
}
