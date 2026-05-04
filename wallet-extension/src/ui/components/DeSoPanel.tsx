/**
 * DeSo settings panel: identity readout + balance + send + post composer + node URL override.
 *
 * pre-release: every send/post mutation hits **DeSo mainnet** and burns real (small) amounts of
 * DESO. the node URL field defaults to `https://node.deso.org`. honesty pill on the panel
 * surfaces this clearly.
 *
 * mounted under SettingsPage alongside the alerts + PC-Token markets sections.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Coins,
  Copy,
  ExternalLink,
  FileText,
  Link2,
  Loader2,
  RefreshCw,
  Send,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { DeSoLinkSection } from './DeSoLinkSection';

type Identity = Awaited<ReturnType<typeof trpc.getDeSoIdentity.query>>;
type Balance = Awaited<ReturnType<typeof trpc.getDeSoBalance.query>>;
type NodeCfg = Awaited<ReturnType<typeof trpc.getDeSoNodeUrl.query>>;

function nanosToDisplay(nanosStr: string): string {
  try {
    const n = BigInt(nanosStr);
    const sign = n < 0n ? '-' : '';
    const abs = n < 0n ? -n : n;
    const whole = abs / 1_000_000_000n;
    const frac = abs % 1_000_000_000n;
    const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
    return `${sign}${whole.toString()}${fracStr ? '.' + fracStr : ''}`;
  } catch {
    return nanosStr;
  }
}

export function DeSoPanel({ advanced }: { advanced: boolean }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [nodeCfg, setNodeCfg] = useState<NodeCfg | null>(null);
  const [busy, setBusy] = useState<'idle' | 'reading-balance' | 'sending' | 'posting'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // send form
  const [sendRecipient, setSendRecipient] = useState('');
  const [sendAmountDeso, setSendAmountDeso] = useState('0.001');

  // post form
  const [postBody, setPostBody] = useState('');

  // node URL override
  const [nodeUrlDraft, setNodeUrlDraft] = useState('');

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const [id, n] = await Promise.all([trpc.getDeSoIdentity.query(), trpc.getDeSoNodeUrl.query()]);
      setIdentity(id);
      setNodeCfg(n);
      setNodeUrlDraft(n.url === n.defaultUrl ? '' : n.url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshBalance = useCallback(async () => {
    setBusy('reading-balance');
    setErr(null);
    try {
      const b = await trpc.getDeSoBalance.query();
      setBalance(b);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function copyAddress() {
    if (!identity) return;
    try {
      await navigator.clipboard.writeText(identity.publicKeyBase58Check);
      setMsg('address copied');
      setTimeout(() => setMsg(null), 1500);
    } catch {
      /* clipboard may be blocked in some contexts; ignore */
    }
  }

  async function handleSend() {
    if (!sendRecipient.trim() || !sendAmountDeso.trim()) {
      setErr('recipient + amount required');
      return;
    }
    setBusy('sending');
    setErr(null);
    setMsg(null);
    try {
      const res = await trpc.sendDeSo.mutate({
        recipient: sendRecipient.trim(),
        amountDeso: sendAmountDeso.trim(),
      });
      setMsg(`✓ sent. tx: ${res.txnHashHex.slice(0, 16)}…`);
      setSendRecipient('');
      await refreshBalance();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  }

  async function handlePost() {
    if (!postBody.trim()) {
      setErr('post body required');
      return;
    }
    setBusy('posting');
    setErr(null);
    setMsg(null);
    try {
      const res = await trpc.submitDeSoPost.mutate({ body: postBody.trim() });
      setMsg(`✓ posted. tx: ${res.txnHashHex.slice(0, 16)}…`);
      setPostBody('');
      await refreshBalance();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  }

  async function saveNodeUrl() {
    setErr(null);
    try {
      await trpc.setDeSoNodeUrl.mutate({ url: nodeUrlDraft });
      await refresh();
      setMsg('node URL saved');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="sp-settingsSection">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Bot size={14} /> deso · social chain
      </h3>
      <div
        className="sp-prealphaPill"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 10,
          padding: '2px 6px',
          borderRadius: 4,
          background: 'rgba(255,196,77,0.15)',
          color: '#ffc44d',
          marginBottom: 8,
        }}
      >
        <AlertTriangle size={10} />
        deso mainnet · real funds
      </div>
      <p className="sp-muted" style={{ fontSize: 12, margin: '0 0 8px 0' }}>
        Your active SECP dWallet IS your DeSo identity (same key, no new material), or you can
        link an existing DeSo account by authorizing chromatika as a derived key. v0 supports
        balance, native send, text post, and derived-key delegation. Diamonds, NFTs, and DeSo
        Messages are future. Sends use small real DESO; ~0.0001 DESO covers fees on a typical send.
      </p>

      {err && (
        <div className="sp-error" style={{ marginBottom: 6, fontSize: 11 }}>
          {err}
        </div>
      )}
      {msg && (
        <div className="sp-muted" style={{ fontSize: 11, color: '#86efac', marginBottom: 6 }}>
          {msg}
        </div>
      )}

      {/* identity + balance row */}
      <div style={{ marginBottom: 10, padding: 8, background: 'rgba(255,255,255,0.03)', borderRadius: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
          <Coins size={11} /> identity
          {identity?.isDelegated && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 10,
                padding: '1px 5px',
                borderRadius: 3,
                background: 'rgba(134,239,172,0.18)',
                color: '#86efac',
                fontWeight: 500,
              }}
              title="chromatika is signing as a derived key on the owner's account"
            >
              <Link2 size={9} /> linked (derived)
            </span>
          )}
        </div>
        {identity ? (
          <>
            <div
              style={{
                fontFamily: 'monospace',
                fontSize: 10,
                marginTop: 4,
                wordBreak: 'break-all',
              }}
            >
              {identity.publicKeyBase58Check}
            </div>
            {identity.isDelegated && identity.derivedPubkeyBase58Check && (
              <div className="sp-muted" style={{ fontSize: 10, marginTop: 2 }}>
                signing as derived key{' '}
                <code style={{ fontFamily: 'monospace' }}>
                  {identity.derivedPubkeyBase58Check.slice(0, 14)}…
                </code>
                {identity.expirationBlock ? (
                  <>
                    {' '}
                    · expires block <code>{identity.expirationBlock}</code>
                  </>
                ) : null}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="sp-btn sp-btn--ghost"
                onClick={() => void copyAddress()}
                style={{ fontSize: 11, padding: '2px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <Copy size={11} /> copy
              </button>
              <a
                href={`https://diamondapp.com/u/${identity.publicKeyBase58Check}`}
                target="_blank"
                rel="noopener noreferrer"
                className="sp-btn sp-btn--ghost"
                style={{ fontSize: 11, padding: '2px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <ExternalLink size={11} /> diamondapp
              </a>
              <span className="sp-muted" style={{ fontSize: 11, marginLeft: 'auto' }}>
                balance: <strong>{balance ? `${nanosToDisplay(balance.balanceNanos)} DESO` : '—'}</strong>
                {balance?.username ? ` · @${balance.username}` : ''}
              </span>
              <button
                type="button"
                className="sp-btn sp-btn--ghost"
                onClick={() => void refreshBalance()}
                disabled={busy !== 'idle'}
                style={{ fontSize: 11, padding: '2px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                {busy === 'reading-balance' ? <Loader2 size={11} className="sp-spin" /> : <RefreshCw size={11} />}
                refresh
              </button>
            </div>
          </>
        ) : (
          <div className="sp-muted" style={{ fontSize: 11 }}>
            <Loader2 size={11} className="sp-spin" /> loading identity…
          </div>
        )}
      </div>

      {/* derived-key delegation linking */}
      <DeSoLinkSection onChange={() => void refresh()} />

      {/* send form */}
      <div style={{ marginBottom: 10, padding: 8, background: 'rgba(255,255,255,0.03)', borderRadius: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          <Send size={11} /> send DESO
        </div>
        <input
          type="text"
          className="sp-input"
          value={sendRecipient}
          onChange={(e) => setSendRecipient(e.target.value)}
          placeholder="recipient (BC1Y… or @username)"
          style={{ fontSize: 11, marginBottom: 4 }}
          disabled={busy !== 'idle'}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            className="sp-input"
            value={sendAmountDeso}
            onChange={(e) => setSendAmountDeso(e.target.value)}
            placeholder="0.001"
            style={{ flex: 1, fontSize: 12 }}
            disabled={busy !== 'idle'}
          />
          <span className="sp-muted" style={{ alignSelf: 'center', fontSize: 11 }}>DESO</span>
          <button
            type="button"
            className="sp-btn sp-btn--primary"
            onClick={() => void handleSend()}
            disabled={busy !== 'idle'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            {busy === 'sending' ? (
              <>
                <Loader2 size={11} className="sp-spin" /> sending…
              </>
            ) : (
              <>
                <Send size={11} /> send
              </>
            )}
          </button>
        </div>
      </div>

      {/* post form */}
      <div style={{ marginBottom: 10, padding: 8, background: 'rgba(255,255,255,0.03)', borderRadius: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          <FileText size={11} /> publish a post
        </div>
        <textarea
          className="sp-input"
          value={postBody}
          onChange={(e) => setPostBody(e.target.value)}
          placeholder="hello chromatika"
          rows={3}
          maxLength={20_000}
          style={{ width: '100%', resize: 'vertical', fontSize: 12, minHeight: 60 }}
          disabled={busy !== 'idle'}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
          <span className="sp-muted" style={{ fontSize: 10 }}>{postBody.length} / 20000 chars</span>
          <button
            type="button"
            className="sp-btn sp-btn--primary"
            onClick={() => void handlePost()}
            disabled={busy !== 'idle' || !postBody.trim()}
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            {busy === 'posting' ? (
              <>
                <Loader2 size={11} className="sp-spin" /> posting…
              </>
            ) : (
              <>
                <FileText size={11} /> publish
              </>
            )}
          </button>
        </div>
      </div>

      {/* advanced: node URL override */}
      {advanced && nodeCfg && (
        <details style={{ marginTop: 6 }}>
          <summary className="sp-muted" style={{ fontSize: 11, cursor: 'pointer' }}>
            node URL (advanced)
          </summary>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input
              type="url"
              className="sp-input"
              value={nodeUrlDraft}
              onChange={(e) => setNodeUrlDraft(e.target.value)}
              placeholder={`(empty = ${nodeCfg.defaultUrl})`}
              style={{ flex: 1, fontSize: 11 }}
            />
            <button type="button" className="sp-btn" onClick={() => void saveNodeUrl()}>
              save
            </button>
          </div>
          <div className="sp-muted" style={{ fontSize: 10, marginTop: 4 }}>
            current: <code>{nodeCfg.url}</code>
          </div>
        </details>
      )}
    </section>
  );
}
