import { useEffect, useMemo, useState } from 'react';
import { Lock } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { ApprovalShell } from '@/ui/components/ApprovalShell';

type Meta = Awaited<ReturnType<typeof trpc.getPendingMcpSignRequest.query>>;

function bytesToUtf8Preview(hex: string): { ascii: string; printable: boolean } {
  const t = hex.trim().replace(/^0x/i, '');
  if (t.length === 0 || t.length % 2 !== 0) return { ascii: '', printable: false };
  try {
    const bytes = new Uint8Array(t.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(t.slice(i * 2, i * 2 + 2), 16);
    }
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const printable = /^[\x20-\x7E\n\r\t]*$/.test(decoded) && decoded.trim().length > 0;
    return { ascii: decoded, printable };
  } catch {
    return { ascii: '', printable: false };
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

/**
 * MCP approve-tier popup. renders when the wallet's tab URL is `?mcpapprove=<id>`. the bg
 * background queued a sign request via `enqueueMcpSign`; this screen surfaces the chain +
 * caller hint + message bytes (hex AND a utf-8 preview when printable) and lets the user
 * approve or reject. approve calls `signMessage{Evm,Sol}` server-side; the result flows back
 * to the queued promise, which the bridge forwards to the external MCP client.
 */
export function McpApprovalScreen({ requestId }: { requestId: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    trpc.getPendingMcpSignRequest
      .query({ id: requestId })
      .then(setMeta)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [requestId]);

  const utf8 = useMemo(() => (meta ? bytesToUtf8Preview(meta.messageHex) : null), [meta]);

  async function onApprove() {
    if (!meta) return;
    setBusy(true);
    setError(null);
    try {
      const r = await trpc.approvePendingMcpSign.mutate({ id: requestId });
      setDone(`signed by ${r.signerAddress}`);
      // small grace so the user sees confirmation, then close.
      setTimeout(() => window.close(), 500);
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
      await trpc.rejectPendingMcpSign.mutate({ id: requestId, reason: 'user_canceled' });
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const lockIcon = <Lock size={16} />;

  if (error && !meta) {
    return (
      <ApprovalShell
        title="mcp sign request"
        icon={lockIcon}
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
        title="mcp sign request"
        icon={lockIcon}
        showClose
        approveDisabled
        approveLabel="approve & sign"
        onApprove={() => {}}
        onReject={() => window.close()}
      >
        <div style={mutedStyle}>loading sign request…</div>
      </ApprovalShell>
    );
  }

  const messagePreview = meta.messageHex.length > 256 ? `${meta.messageHex.slice(0, 256)}…` : meta.messageHex;
  const utf8Display = utf8?.printable
    ? utf8.ascii.length > 256
      ? `${utf8.ascii.slice(0, 256)}…`
      : utf8.ascii
    : null;

  return (
    <ApprovalShell
      title="mcp sign request"
      icon={lockIcon}
      showClose
      busy={busy}
      busyLabel="signing…"
      approveLabel="approve & sign"
      approveDisabled={done != null}
      onApprove={() => void onApprove()}
      onReject={() => void onReject()}
      error={error}
      success={done}
    >
      <div style={badgeRowStyle}>
        <span style={chainBadgeStyle}>{meta.chain.toUpperCase()}</span>
        {meta.chain === 'evm' && meta.evmChainId != null && (
          <span style={mutedBadgeStyle}>chainId {meta.evmChainId}</span>
        )}
        <span style={mutedBadgeStyle}>{relTime(meta.enqueuedAtMs)}</span>
      </div>

      {meta.callerHint && (
        <div style={callerStyle} title="caller-supplied hint - not authenticated">
          requested by: <span style={callerNameStyle}>{meta.callerHint}</span>
        </div>
      )}

      <div style={sectionLabelStyle}>message bytes (hex)</div>
      <pre style={hexStyle}>{messagePreview}</pre>
      {meta.messageHex.length > 256 && (
        <div style={mutedStyle}>showing first 256 of {meta.messageHex.length} hex chars</div>
      )}

      {utf8Display !== null && (
        <>
          <div style={sectionLabelStyle}>utf-8 preview</div>
          <pre style={asciiStyle}>{utf8Display}</pre>
        </>
      )}

      <div style={warningStyle}>
        the agent will use this signature however it wants. only approve if you understand what you're signing.
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

const hexStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 10.5,
  background: 'rgba(15, 23, 42, 0.6)',
  border: '1px solid rgba(99, 102, 241, 0.22)',
  borderRadius: 6,
  padding: '6px 8px',
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  maxHeight: 120,
  overflow: 'auto',
  color: 'rgba(234, 240, 255, 0.92)',
};

const asciiStyle: React.CSSProperties = {
  ...hexStyle,
  fontSize: 11,
  color: 'rgba(165, 180, 252, 0.95)',
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
