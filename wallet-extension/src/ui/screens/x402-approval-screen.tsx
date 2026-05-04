import { useEffect, useState, type CSSProperties } from 'react';
import { CreditCard } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { ApprovalShell } from '@/ui/components/ApprovalShell';

type Meta = Awaited<ReturnType<typeof trpc.getPendingX402Request.query>>;

function formatUsdc(atomic: string): string {
  try {
    const big = BigInt(atomic);
    const decimals = 6n; // USDC
    const whole = big / 10n ** decimals;
    const frac = big % 10n ** decimals;
    return `${whole.toString()}.${frac.toString().padStart(6, '0').replace(/0+$/, '') || '0'}`;
  } catch {
    return atomic;
  }
}

function shortAddr(s: string, head = 6, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function relTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 1000) return 'just now';
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

/**
 * x402 payment approval popup. renders when the wallet's tab URL is `?x402approve=<id>`.
 * the dispatcher queued a payment request; this screen surfaces seller + amount + USD
 * estimate + the on-chain destination ATA, and lets the user approve or reject.
 *
 * approve, tRPC `approvePendingX402` runs the Solana signer and resolves the queued promise
 * with the signed PAYMENT-SIGNATURE header value. the dispatcher then returns that header to
 * the original caller (eventually the page's fetch wrapper).
 */
export function X402ApprovalScreen({ requestId }: { requestId: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    trpc.getPendingX402Request
      .query({ id: requestId })
      .then(setMeta)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [requestId]);

  async function onApprove() {
    if (!meta) return;
    setBusy(true);
    setError(null);
    try {
      const r = await trpc.approvePendingX402.mutate({ id: requestId });
      setDone(`signed · paying ${formatUsdc(meta.requirements.maxAmountRequired)} USDC to ${shortAddr(meta.requirements.payTo)}`);
      // small grace so user sees confirmation, then close
      setTimeout(() => window.close(), 600);
      void r;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onReject() {
    setBusy(true);
    setError(null);
    try {
      await trpc.rejectPendingX402.mutate({ id: requestId, reason: 'user_canceled' });
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const cardIcon = <CreditCard size={16} />;

  if (error && !meta) {
    return (
      <ApprovalShell
        title="x402 payment"
        icon={cardIcon}
        showClose
        approveLabel="close"
        rejectLabel="close"
        onApprove={() => window.close()}
        onReject={() => window.close()}
        error={error}
      >
        <div />
      </ApprovalShell>
    );
  }

  if (!meta) {
    return (
      <ApprovalShell
        title="x402 payment"
        icon={cardIcon}
        showClose
        approveDisabled
        approveLabel="approve"
        onApprove={() => {}}
        onReject={() => window.close()}
      >
        <div style={mutedStyle}>loading…</div>
      </ApprovalShell>
    );
  }

  const { requirements } = meta;
  const amountUsdc = formatUsdc(requirements.maxAmountRequired);

  return (
    <ApprovalShell
      title="x402 payment"
      icon={cardIcon}
      showClose
      busy={busy}
      busyLabel="signing…"
      approveLabel={`approve · pay $${amountUsdc}`}
      approveDisabled={done != null}
      onApprove={() => void onApprove()}
      onReject={() => void onReject()}
      error={error}
      success={done}
    >
      <div style={badgeRowStyle}>
        <span style={chainBadgeStyle}>SOLANA</span>
        <span style={mutedBadgeStyle}>USDC</span>
        <span style={mutedBadgeStyle}>{relTime(meta.enqueuedAtMs)}</span>
      </div>

      <div style={amountRowStyle}>
        <div style={amountLabelStyle}>amount</div>
        <div style={amountValueStyle}>
          ${amountUsdc} USDC
          {meta.estimatedUsd != null && (
            <span style={amountEstStyle}> ≈ ${meta.estimatedUsd.toFixed(4)}</span>
          )}
        </div>
      </div>

      <div style={fieldRowStyle}>
        <div style={fieldLabelStyle}>resource</div>
        <div style={fieldValueStyle}>{requirements.resource}</div>
      </div>

      <div style={fieldRowStyle}>
        <div style={fieldLabelStyle}>seller wallet</div>
        <div style={fieldMonoStyle}>{shortAddr(requirements.payTo, 8, 8)}</div>
      </div>

      <div style={fieldRowStyle}>
        <div style={fieldLabelStyle}>seller host</div>
        <div style={fieldValueStyle}>{meta.sellerHost}</div>
      </div>

      {meta.callerHint && (
        <div style={fieldRowStyle}>
          <div style={fieldLabelStyle}>requested by</div>
          <div style={fieldValueStyle}>{meta.callerHint}</div>
        </div>
      )}

      {requirements.description && (
        <div style={fieldRowStyle}>
          <div style={fieldLabelStyle}>description</div>
          <div style={fieldValueStyle}>{requirements.description}</div>
        </div>
      )}

      <div style={warningStyle}>
        the facilitator submits this transfer on your behalf. once approved, it can broadcast to
        Solana within seconds. caps in Settings → Payments can block future overspend.
      </div>
    </ApprovalShell>
  );
}

const badgeRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  marginBottom: 8,
};

const chainBadgeStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: 0.06,
  padding: '2px 8px',
  borderRadius: 999,
  background: 'rgba(147, 197, 253, 0.18)',
  color: 'rgba(147, 197, 253, 0.95)',
  border: '1px solid rgba(147, 197, 253, 0.3)',
  fontWeight: 600,
};

const mutedBadgeStyle: CSSProperties = {
  fontSize: 10,
  padding: '2px 6px',
  borderRadius: 999,
  background: 'rgba(15, 23, 42, 0.55)',
  color: 'rgba(234, 240, 255, 0.6)',
  border: '1px solid rgba(99, 102, 241, 0.18)',
};

const amountRowStyle: CSSProperties = {
  background: 'rgba(15, 23, 42, 0.55)',
  border: '1px solid rgba(99, 102, 241, 0.22)',
  borderRadius: 8,
  padding: '10px 12px',
  marginTop: 4,
  marginBottom: 8,
};

const amountLabelStyle: CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.04,
  color: 'rgba(234, 240, 255, 0.5)',
};

const amountValueStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  marginTop: 2,
  fontFamily: 'ui-monospace, monospace',
  color: 'rgba(234, 240, 255, 0.95)',
};

const amountEstStyle: CSSProperties = {
  fontSize: 12,
  color: 'rgba(234, 240, 255, 0.5)',
  marginLeft: 6,
  fontWeight: 400,
};

const fieldRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  marginTop: 4,
};

const fieldLabelStyle: CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.04,
  color: 'rgba(234, 240, 255, 0.5)',
};

const fieldValueStyle: CSSProperties = {
  fontSize: 12,
  color: 'rgba(234, 240, 255, 0.92)',
  wordBreak: 'break-all',
};

const fieldMonoStyle: CSSProperties = {
  ...fieldValueStyle,
  fontFamily: 'ui-monospace, monospace',
};

const mutedStyle: CSSProperties = {
  fontSize: 11,
  color: 'rgba(234, 240, 255, 0.55)',
};

const warningStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  padding: '6px 8px',
  borderRadius: 6,
  background: 'rgba(252, 211, 77, 0.08)',
  border: '1px solid rgba(252, 211, 77, 0.3)',
  color: 'rgba(252, 211, 77, 0.95)',
  marginTop: 6,
};
