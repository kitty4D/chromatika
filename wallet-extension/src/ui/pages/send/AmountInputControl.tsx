import { useCallback, useMemo } from 'react';
import { formatUsd } from '@/lib/sui-amount';
import type { SendAmountInputMode } from '@/lib/use-send-amount-input-mode';

/**
 * amount control for the Send Confirm step. supports both modes:
 *  - `number`: classic decimal input + Max button.
 *  - `slider`: 0 -> effectiveMax with 100 discrete steps; live USD readout.
 *
 * `effectiveMax` is `min(balanceMax, policyMaxTokenAmount ?? balanceMax)`. when the binding
 * constraint is the policy cap, a "policy cap" pill renders to explain why Max stops short of
 * the wallet balance. clamping is enforced on commit + every keystroke.
 */
export function AmountInputControl(props: {
  mode: SendAmountInputMode;
  tokenSymbol: string;
  decimals: number;
  /** maximum amount based on wallet balance (decimal string, e.g. "2.5"). */
  balanceMax: string;
  /** maximum allowed by the policy cap (decimal string). undefined means no policy clamp. */
  policyMaxTokenAmount?: string;
  /**
   * decimal amount of the *token being sent* to reserve from Max so the source address keeps
   * enough left to pay native-chain gas. only applies when the token is itself the native gas
   * asset (sending SUI from a Sui address, ETH from an EVM address, SOL from a Solana address).
   * undefined means no gas reservation (Max == full balance / policy cap).
   */
  gasReserveAmount?: string;
  pricePerTokenUsd?: number | null;
  value: string;
  onChange: (next: string) => void;
}) {
  const {
    mode,
    tokenSymbol,
    decimals,
    balanceMax,
    policyMaxTokenAmount,
    gasReserveAmount,
    pricePerTokenUsd,
    value,
    onChange,
  } = props;

  const balanceNum = useMemo(() => Number.parseFloat(balanceMax) || 0, [balanceMax]);
  const policyNum = useMemo(
    () => (policyMaxTokenAmount != null ? Number.parseFloat(policyMaxTokenAmount) : null),
    [policyMaxTokenAmount],
  );
  const gasReserveNum = useMemo(
    () => (gasReserveAmount != null ? Math.max(0, Number.parseFloat(gasReserveAmount) || 0) : 0),
    [gasReserveAmount],
  );
  const effectiveMaxNum = useMemo(() => {
    // gas-reserved balance: never below 0.
    const gasReserved = Math.max(0, balanceNum - gasReserveNum);
    if (policyNum != null && policyNum < gasReserved) return policyNum;
    return gasReserved;
  }, [balanceNum, policyNum, gasReserveNum]);
  const policyIsBinding = policyNum != null && policyNum < Math.max(0, balanceNum - gasReserveNum);
  const gasReserveIsBinding = gasReserveNum > 0 && (policyNum == null || policyNum >= balanceNum - gasReserveNum);
  const valueNum = useMemo(() => Number.parseFloat(value) || 0, [value]);
  const valueUsd =
    pricePerTokenUsd != null && pricePerTokenUsd > 0 && valueNum > 0
      ? pricePerTokenUsd * valueNum
      : null;

  const setMax = useCallback(() => {
    onChange(formatAmount(effectiveMaxNum, decimals));
  }, [onChange, effectiveMaxNum, decimals]);

  const onTextChange = useCallback(
    (raw: string) => {
      const cleaned = raw.replace(/[^0-9.]/g, '');
      const n = Number.parseFloat(cleaned);
      if (Number.isNaN(n)) {
        onChange(cleaned);
        return;
      }
      if (n > effectiveMaxNum) {
        onChange(formatAmount(effectiveMaxNum, decimals));
        return;
      }
      onChange(cleaned);
    },
    [onChange, effectiveMaxNum, decimals],
  );

  const onSliderChange = useCallback(
    (raw: string) => {
      const pct = Math.min(100, Math.max(0, Number.parseInt(raw, 10) || 0));
      const next = (effectiveMaxNum * pct) / 100;
      onChange(formatAmount(next, decimals));
    },
    [onChange, effectiveMaxNum, decimals],
  );

  const sliderPct = useMemo(() => {
    if (effectiveMaxNum <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((valueNum / effectiveMaxNum) * 100)));
  }, [valueNum, effectiveMaxNum]);

  return (
    <div className="sp-section">
      <label className="sp-sectionTitle" htmlFor="send-amount">
        amount
      </label>

      {mode === 'number' ? (
        <div className="sp-amountRow">
          <input
            id="send-amount"
            type="text"
            inputMode="decimal"
            className="sp-input sp-inputAmount"
            placeholder="0.00"
            value={value}
            onChange={(e) => onTextChange(e.target.value)}
            aria-label="send amount"
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="sp-btn"
            style={{ fontSize: 11, padding: '4px 8px' }}
            onClick={setMax}
            aria-label={`set amount to maximum ${effectiveMaxNum} ${tokenSymbol}`}
          >
            Max
          </button>
          <span className="sp-amountUnit">{tokenSymbol}</span>
        </div>
      ) : (
        <>
          <div className="sp-amountRow" style={{ alignItems: 'center', gap: 10 }}>
            <input
              id="send-amount"
              type="range"
              min={0}
              max={100}
              step={1}
              value={sliderPct}
              onChange={(e) => onSliderChange(e.target.value)}
              aria-label={`send amount slider (0 to ${effectiveMaxNum} ${tokenSymbol})`}
              style={{ flex: 1 }}
            />
            <span
              style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13, minWidth: 90, textAlign: 'right' }}
            >
              {formatAmount(valueNum, Math.min(decimals, 6))} {tokenSymbol}
            </span>
          </div>
          <div className="sp-muted" style={{ fontSize: 11, marginTop: 4 }}>
            {sliderPct}% of max ({formatAmount(effectiveMaxNum, Math.min(decimals, 6))} {tokenSymbol})
          </div>
        </>
      )}

      <div
        className="sp-muted"
        style={{ fontSize: 11, marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
      >
        <span>
          balance: {formatAmount(balanceNum, Math.min(decimals, 6))} {tokenSymbol}
        </span>
        {valueUsd != null ? <span>~ {formatUsd(valueUsd)}</span> : null}
        {policyIsBinding ? (
          <span
            style={{
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 4,
              background: 'rgba(255,196,77,0.12)',
              border: '1px solid rgba(255,196,77,0.4)',
              color: '#ffc44d',
            }}
            title="policy vault cap leaves less than wallet balance"
          >
            policy cap leaves ~{formatAmount(effectiveMaxNum, Math.min(decimals, 6))} {tokenSymbol}
          </span>
        ) : gasReserveIsBinding ? (
          <span
            style={{
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 4,
              background: 'rgba(96,165,250,0.12)',
              border: '1px solid rgba(96,165,250,0.4)',
              color: '#60a5fa',
            }}
            title="leaves a small amount behind to pay network gas"
          >
            reserves ~{formatAmount(gasReserveNum, Math.min(decimals, 6))} {tokenSymbol} for gas
          </span>
        ) : null}
      </div>
    </div>
  );
}

function formatAmount(n: number, decimals: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  const fixed = n.toFixed(Math.min(decimals, 8));
  // strip trailing zeros so "1.000000" -> "1" and "1.250000" -> "1.25"
  return fixed.replace(/\.?0+$/, '');
}
