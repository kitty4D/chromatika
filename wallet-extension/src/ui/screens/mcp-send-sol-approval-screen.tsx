/**
 * MCP send-Solana-tx approval popup. renders when the wallet's tab URL is `?mcpsendsol=<id>`.
 * sibling of `mcp-approval-screen.tsx` (signMessage). v1 supports native SOL transfer only:
 * the queued meta is `{ to, lamports, fromAddress, callerHint }`.
 *
 * approve calls `approvePendingMcpSendSol` server-side; the wallet signs + broadcasts via the
 * existing `sendSolanaNativeTransfer` (which also writes to the tx-record store so the activity
 * feed picks up the send). the result flows back to the queued promise, MCP client.
 */

import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { ApprovalShell } from '@/ui/components/ApprovalShell';

type Meta = Awaited<ReturnType<typeof trpc.getPendingMcpSendSolRequest.query>>;

function lamportsToSolDisplay(lamportsStr: string): string {
  try {
    const lamports = BigInt(lamportsStr);
    const sol = Number(lamports) / 1_000_000_000;
    return sol.toLocaleString('en-US', { maximumFractionDigits: 9 });
  } catch {
    return lamportsStr;
  }
}

function relTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 1000) return 'just now';
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}

export function McpSendSolApprovalScreen({ requestId }: { requestId: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    trpc.getPendingMcpSendSolRequest
      .query({ id: requestId })
      .then(setMeta)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [requestId]);

  async function onApprove() {
    if (!meta) return;
    setBusy(true);
    setError(null);
    try {
      const r = await trpc.approvePendingMcpSendSol.mutate({ id: requestId });
      setDone(`broadcast: ${r.signature.slice(0, 16)}…`);
      setTimeout(() => window.close(), 700);
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
      await trpc.rejectPendingMcpSendSol.mutate({ id: requestId, reason: 'user_canceled' });
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const sendIcon = <Send size={16} />;

  if (error && !meta) {
    return (
      <ApprovalShell
        title="mcp send · solana"
        icon={sendIcon}
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
        title="mcp send · solana"
        icon={sendIcon}
        showClose
        approveDisabled
        approveLabel="approve & send"
        onApprove={() => {}}
        onReject={() => window.close()}
      >
        <div style={mutedStyle}>loading send request…</div>
      </ApprovalShell>
    );
  }

  return (
    <ApprovalShell
      title="mcp send · solana"
      icon={sendIcon}
      showClose
      busy={busy}
      busyLabel="sending…"
      approveLabel="approve & send"
      approveDisabled={done != null}
      onApprove={() => void onApprove()}
      onReject={() => void onReject()}
      error={error}
      success={done}
    >
      <div style={badgeRowStyle}>
        <span style={chainBadgeStyle}>{meta.kind === 'spl' ? 'SPL' : 'SOL'}</span>
        <span style={mutedBadgeStyle}>{relTime(meta.enqueuedAtMs)}</span>
      </div>

      {meta.callerHint && (
        <div style={callerStyle} title="caller-supplied hint - not authenticated">
          requested by: <span style={callerNameStyle}>{meta.callerHint}</span>
        </div>
      )}

      <div style={sectionLabelStyle}>amount</div>
      {meta.kind === 'spl' && meta.amountRaw && meta.mint ? (
        <>
          <div style={amountStyle}>{meta.amountRaw} base-units</div>
          <div style={mutedStyle}>mint: {meta.mint}</div>
        </>
      ) : (
        <>
          <div style={amountStyle}>{lamportsToSolDisplay(meta.lamports ?? '0')} SOL</div>
          <div style={mutedStyle}>{meta.lamports ?? '0'} lamports</div>
        </>
      )}

      <div style={sectionLabelStyle}>from</div>
      <pre style={addressStyle}>{meta.fromAddress}</pre>

      <div style={sectionLabelStyle}>to</div>
      <pre style={addressStyle}>{meta.to}</pre>

      <div style={warningStyle}>
        approving signs + broadcasts {meta.kind === 'spl' ? 'an SPL token transfer' : 'a native SOL transfer'}{' '}
        immediately. only approve if you understand the destination + amount. the agent that requested
        this is not authenticated.
      </div>
    </ApprovalShell>
  );
}

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.04,
  color: 'rgba(234, 240, 255, 0.5)',
  marginTop: 6,
};

const amountStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: 'rgba(234, 240, 255, 0.95)',
};

const addressStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 10.5,
  background: 'rgba(15, 23, 42, 0.6)',
  border: '1px solid rgba(99, 102, 241, 0.22)',
  borderRadius: 6,
  padding: '6px 8px',
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  color: 'rgba(234, 240, 255, 0.92)',
};

const badgeRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  marginBottom: 8,
};

const chainBadgeStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 0.06,
  padding: '2px 8px',
  borderRadius: 999,
  background: 'rgba(147, 197, 253, 0.18)',
  color: 'rgba(147, 197, 253, 0.95)',
  border: '1px solid rgba(147, 197, 253, 0.3)',
  fontWeight: 600,
};

const mutedBadgeStyle: React.CSSProperties = {
  fontSize: 10,
  padding: '2px 6px',
  borderRadius: 999,
  background: 'rgba(15, 23, 42, 0.55)',
  color: 'rgba(234, 240, 255, 0.6)',
  border: '1px solid rgba(99, 102, 241, 0.18)',
};

const callerStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'rgba(234, 240, 255, 0.7)',
  marginBottom: 6,
};

const callerNameStyle: React.CSSProperties = {
  color: 'rgba(234, 240, 255, 0.95)',
  fontWeight: 500,
};

const mutedStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'rgba(234, 240, 255, 0.55)',
};

const warningStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  padding: '6px 8px',
  borderRadius: 6,
  background: 'rgba(252, 211, 77, 0.08)',
  border: '1px solid rgba(252, 211, 77, 0.3)',
  color: 'rgba(252, 211, 77, 0.95)',
  marginTop: 6,
};
