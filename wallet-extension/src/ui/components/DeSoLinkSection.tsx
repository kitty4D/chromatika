/**
 * DeSo derived-key delegation linking UI. lets an existing DeSo user authorize chromatika's
 * dWallet pubkey as a derived key on their account. lives inside `DeSoPanel`.
 *
 * two-step flow (per `wallet-extension/docs/DESO_DERIVED_KEY_SPIKE.md` Path A):
 *   1. open Identity `/derive` window via `window.open`, wait for postMessage with the
 *      `accessSignature + expirationBlock` payload.
 *   2. backend constructs an unsigned AuthorizeDerivedKey tx, open Identity `/approve` window,
 *      wait for postMessage with the owner-signed tx hex.
 *   3. backend submits + persists; UI polls verification on +3s/+10s/exp-backoff cadence.
 *
 * surface gate: window.open + postMessage only works reliably in the SIDE PANEL (popup closes on
 * blur). in popup we show a "open in side panel to link" button that invokes
 * `chrome.sidePanel.open(...)` when available, or falls back to copy-paste guidance.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Link2,
  Link2Off,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';

type OwnerLink = NonNullable<Awaited<ReturnType<typeof trpc.getDeSoOwnerLink.query>>['link']>;
type DeriveUrlInfo = Awaited<ReturnType<typeof trpc.buildDeSoIdentityDeriveUrl.query>>;

const IDENTITY_ORIGIN = 'https://identity.deso.org';

type FlowState =
  | { kind: 'idle' }
  | { kind: 'derive-window-open'; win: Window | null; urlInfo: DeriveUrlInfo }
  | { kind: 'derive-received'; payload: DerivePayload; urlInfo: DeriveUrlInfo }
  | { kind: 'constructing' }
  | { kind: 'approve-window-open'; win: Window | null; unsignedTransactionHex: string; payload: DerivePayload; spendingLimitHex: string }
  | { kind: 'submitting'; signedTransactionHex: string; payload: DerivePayload; spendingLimitHex: string }
  | { kind: 'verifying'; txnHashHex: string; attempt: number }
  | { kind: 'verified'; link: OwnerLink };

interface DerivePayload {
  derivedPublicKeyBase58Check: string;
  publicKeyBase58Check: string; // owner
  expirationBlock: number;
  accessSignature: string;
  transactionSpendingLimitHex?: string;
}

function isInSidePanel(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.classList.contains('ch-ext--sidepanel');
}

/** try several common shapes when extracting Identity's payload from a `MessageEvent.data`. */
function extractDerivePayload(data: unknown): DerivePayload | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  // some wrappers nest the result under `payload` and route by `method`.
  const inner =
    d.payload && typeof d.payload === 'object' ? (d.payload as Record<string, unknown>) : d;
  const derivedPublicKeyBase58Check = pickString(inner, [
    'derivedPublicKeyBase58Check',
    'DerivedPublicKeyBase58Check',
  ]);
  const publicKeyBase58Check = pickString(inner, ['publicKeyBase58Check', 'PublicKeyBase58Check']);
  const accessSignature = pickString(inner, ['accessSignature', 'AccessSignature']);
  const expirationBlock = pickNumber(inner, ['expirationBlock', 'ExpirationBlock']);
  if (!derivedPublicKeyBase58Check || !publicKeyBase58Check || !accessSignature || !expirationBlock) {
    return null;
  }
  const transactionSpendingLimitHex =
    pickString(inner, ['transactionSpendingLimitHex', 'TransactionSpendingLimitHex']) ?? undefined;
  return {
    derivedPublicKeyBase58Check,
    publicKeyBase58Check,
    expirationBlock,
    accessSignature,
    transactionSpendingLimitHex,
  };
}

function extractApprovePayload(data: unknown): { signedTransactionHex: string } | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const inner =
    d.payload && typeof d.payload === 'object' ? (d.payload as Record<string, unknown>) : d;
  const signedTransactionHex = pickString(inner, [
    'signedTransactionHex',
    'SignedTransactionHex',
    'signedHex',
  ]);
  if (!signedTransactionHex) return null;
  return { signedTransactionHex };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  return null;
}

export function DeSoLinkSection({ onChange }: { onChange?: () => void }) {
  const [link, setLink] = useState<OwnerLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [flow, setFlow] = useState<FlowState>({ kind: 'idle' });
  const [ownerInput, setOwnerInput] = useState('');
  const [unlinkBusy, setUnlinkBusy] = useState(false);

  const flowRef = useRef(flow);
  useEffect(() => {
    flowRef.current = flow;
  }, [flow]);

  const refreshLink = useCallback(async () => {
    setLoading(true);
    try {
      const r = await trpc.getDeSoOwnerLink.query();
      setLink(r.link as OwnerLink | null);
      if (r.link?.verifiedAtMs) {
        setFlow({ kind: 'verified', link: r.link as OwnerLink });
      } else if (!r.link) {
        setFlow({ kind: 'idle' });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshLink();
  }, [refreshLink]);

  // global postMessage listener; Identity sends to `window.opener.postMessage(...)`.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // only accept messages from Identity's exact origin.
      if (event.origin !== IDENTITY_ORIGIN) return;
      const cur = flowRef.current;
      if (cur.kind === 'derive-window-open') {
        const payload = extractDerivePayload(event.data);
        if (!payload) return;
        // sanity: make sure derived key Identity returned matches the URL we built.
        if (payload.derivedPublicKeyBase58Check !== cur.urlInfo.derivedPubkeyBase58Check) {
          setErr(
            `Identity returned a derived key that does not match this dWallet (${payload.derivedPublicKeyBase58Check} != ${cur.urlInfo.derivedPubkeyBase58Check}). Aborting.`,
          );
          try { cur.win?.close(); } catch { /* ignore */ }
          setFlow({ kind: 'idle' });
          return;
        }
        try { cur.win?.close(); } catch { /* ignore */ }
        setFlow({ kind: 'derive-received', payload, urlInfo: cur.urlInfo });
        // auto-advance to construct + open approve window.
        void runConstructAndOpenApprove(payload, cur.urlInfo);
      } else if (cur.kind === 'approve-window-open') {
        const approve = extractApprovePayload(event.data);
        if (!approve) return;
        try { cur.win?.close(); } catch { /* ignore */ }
        setFlow({
          kind: 'submitting',
          signedTransactionHex: approve.signedTransactionHex,
          payload: cur.payload,
          spendingLimitHex: cur.spendingLimitHex,
        });
        void runSubmit(approve.signedTransactionHex, cur.payload, cur.spendingLimitHex);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // runConstruct... and runSubmit are referenced via the latest state ref; safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startLinkFlow = useCallback(async () => {
    setErr(null);
    if (!isInSidePanel()) {
      try {
        const win: any = await new Promise((resolve, reject) => {
          if (typeof chrome !== 'undefined' && chrome.windows?.getCurrent) {
            chrome.windows.getCurrent({}, (w) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(w);
            });
          } else {
            reject(new Error('chrome.windows unavailable'));
          }
        });
        if (typeof chrome !== 'undefined' && (chrome as any).sidePanel?.open) {
          await (chrome as any).sidePanel.open({ windowId: win?.id });
          setErr('Opened the side panel; finish linking from there. (Popup can\'t host the Identity flow because it closes on blur.)');
          return;
        }
      } catch (e) {
        // fall through
      }
      setErr('Open the chromatika side panel to link your DeSo account. Popup can\'t host Identity\'s consent window.');
      return;
    }

    try {
      const ownerTrim = ownerInput.trim();
      const urlInfo = await trpc.buildDeSoIdentityDeriveUrl.query(
        ownerTrim ? { ownerPubkeyBase58Check: ownerTrim } : undefined,
      );
      const win = window.open(urlInfo.url, 'chromatika-deso-identity', 'width=440,height=720');
      if (!win) {
        setErr('Failed to open Identity window: check your browser\'s popup blocker.');
        return;
      }
      setFlow({ kind: 'derive-window-open', win, urlInfo });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [ownerInput]);

  const runConstructAndOpenApprove = useCallback(
    async (payload: DerivePayload, urlInfo: DeriveUrlInfo) => {
      setFlow({ kind: 'constructing' });
      setErr(null);
      try {
        const spendingLimitHex =
          payload.transactionSpendingLimitHex && payload.transactionSpendingLimitHex.length > 0
            ? payload.transactionSpendingLimitHex
            : urlInfo.spendingLimitHex;
        const construct = await trpc.constructDeSoOwnerLink.mutate({
          ownerPubkeyBase58Check: payload.publicKeyBase58Check,
          derivedPubkeyBase58Check: payload.derivedPublicKeyBase58Check,
          accessSignatureHex: payload.accessSignature,
          expirationBlock: payload.expirationBlock,
          spendingLimitHex,
        });
        const win = window.open(
          construct.approveUrl,
          'chromatika-deso-approve',
          'width=440,height=720',
        );
        if (!win) {
          setErr('Failed to open Identity /approve window. Check popup blockers.');
          setFlow({ kind: 'idle' });
          return;
        }
        setFlow({
          kind: 'approve-window-open',
          win,
          unsignedTransactionHex: construct.unsignedTransactionHex,
          payload,
          spendingLimitHex: construct.spendingLimitHex,
        });
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        setFlow({ kind: 'idle' });
      }
    },
    [],
  );

  const runSubmit = useCallback(
    async (signedTransactionHex: string, payload: DerivePayload, spendingLimitHex: string) => {
      setErr(null);
      try {
        const res = await trpc.submitDeSoOwnerLink.mutate({
          signedTransactionHex,
          ownerPubkeyBase58Check: payload.publicKeyBase58Check,
          expirationBlock: payload.expirationBlock,
          spendingLimitHex,
        });
        setLink(res.link as OwnerLink | null);
        setFlow({ kind: 'verifying', txnHashHex: res.txnHashHex, attempt: 0 });
        // kick off the verification poll.
        void runVerifyPoll();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        setFlow({ kind: 'idle' });
      }
    },
    [],
  );

  const runVerifyPoll = useCallback(async () => {
    // +3s, +10s, then exponential backoff up to 60s; max ~7 attempts (~2 min).
    const delaysMs = [3_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000];
    for (let i = 0; i < delaysMs.length; i++) {
      await new Promise((r) => setTimeout(r, delaysMs[i]!));
      try {
        const res = await trpc.pollDeSoOwnerLinkVerification.mutate();
        if (res.verified && res.link) {
          setLink(res.link as OwnerLink);
          setFlow({ kind: 'verified', link: res.link as OwnerLink });
          onChange?.();
          return;
        }
        setFlow((s) => (s.kind === 'verifying' ? { ...s, attempt: i + 1 } : s));
      } catch (e) {
        // soft-fail; the next loop tick retries.
        console.warn('[chromatika DeSo link] verification poll failed:', e);
      }
    }
    // time-out gracefully: link is persisted; user can keep refreshing manually.
    setErr(
      'Authorize-derived-key tx submitted, but verification poll timed out. The on-chain key may still be valid; try the manual refresh.',
    );
  }, [onChange]);

  const handleManualVerifyRefresh = useCallback(async () => {
    setErr(null);
    try {
      const res = await trpc.pollDeSoOwnerLinkVerification.mutate();
      setLink(res.link as OwnerLink | null);
      if (res.verified && res.link) {
        setFlow({ kind: 'verified', link: res.link as OwnerLink });
        onChange?.();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [onChange]);

  const handleUnlink = useCallback(async () => {
    setUnlinkBusy(true);
    setErr(null);
    try {
      await trpc.clearDeSoOwnerLink.mutate();
      setLink(null);
      setFlow({ kind: 'idle' });
      onChange?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUnlinkBusy(false);
    }
  }, [onChange]);

  return (
    <div style={{ marginBottom: 10, padding: 8, background: 'rgba(255,255,255,0.03)', borderRadius: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        <Link2 size={11} /> link existing DeSo account (derived key)
      </div>
      <p className="sp-muted" style={{ fontSize: 11, margin: '0 0 6px 0' }}>
        Authorize chromatika's dWallet as a derived key on your DeSo account. Owner key never
        leaves Identity. Sends + posts use your existing handle. v0 = unlimited spending limit
        with a 30-day expiry.
      </p>
      {err && (
        <div className="sp-error" style={{ marginBottom: 6, fontSize: 11 }}>
          <AlertTriangle size={11} style={{ verticalAlign: 'middle' }} /> {err}
        </div>
      )}

      {loading && (
        <div className="sp-muted" style={{ fontSize: 11 }}>
          <Loader2 size={11} className="sp-spin" /> loading link state…
        </div>
      )}

      {!loading && link && (
        <div style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            {link.verifiedAtMs ? (
              <>
                <CheckCircle2 size={11} color="#86efac" /> linked to{' '}
                <code style={{ fontFamily: 'monospace', fontSize: 10 }}>
                  {link.ownerPubkeyBase58Check.slice(0, 14)}…
                </code>
              </>
            ) : (
              <>
                <Loader2 size={11} className="sp-spin" /> link tx submitted, awaiting on-chain
                confirmation
              </>
            )}
          </div>
          <div className="sp-muted" style={{ fontSize: 10, marginTop: 4 }}>
            tx: <code>{link.txnHashHex.slice(0, 16)}…</code> · expires block{' '}
            <code>{link.expirationBlock}</code> · spending limit:{' '}
            <code>{link.spendingLimit.kind === 'unlimited' ? 'unlimited' : 'scoped'}</code>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {!link.verifiedAtMs && (
              <button
                type="button"
                className="sp-btn sp-btn--ghost"
                onClick={() => void handleManualVerifyRefresh()}
                style={{ fontSize: 11, padding: '2px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <RefreshCw size={11} /> check verification
              </button>
            )}
            <button
              type="button"
              className="sp-btn sp-btn--ghost"
              onClick={() => void handleUnlink()}
              disabled={unlinkBusy}
              style={{ fontSize: 11, padding: '2px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              {unlinkBusy ? <Loader2 size={11} className="sp-spin" /> : <Link2Off size={11} />} unlink (local)
            </button>
          </div>
          <div className="sp-muted" style={{ fontSize: 10, marginTop: 4 }}>
            "Unlink (local)" stops chromatika from signing as the owner. The on-chain
            authorization remains valid until the expiration block; revoke via Diamond's settings
            page or a follow-up AuthorizeDerivedKey tx (v1 work).
          </div>
        </div>
      )}

      {!loading && !link && (
        <div>
          {flow.kind === 'idle' && (
            <div>
              <input
                type="text"
                className="sp-input"
                value={ownerInput}
                onChange={(e) => setOwnerInput(e.target.value)}
                placeholder="(optional) owner BC1Y… (leave blank to pick in Identity)"
                style={{ fontSize: 11, marginBottom: 4 }}
              />
              <button
                type="button"
                className="sp-btn sp-btn--primary"
                onClick={() => void startLinkFlow()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <ExternalLink size={11} /> open Identity to authorize
                <ArrowRight size={11} />
              </button>
              {!isInSidePanel() && (
                <div className="sp-muted" style={{ fontSize: 10, marginTop: 4 }}>
                  Tip: open the chromatika side panel first; popup closes when you click into
                  Identity.
                </div>
              )}
            </div>
          )}
          {flow.kind === 'derive-window-open' && (
            <div className="sp-muted" style={{ fontSize: 11 }}>
              <Loader2 size={11} className="sp-spin" /> waiting for owner consent in Identity…
            </div>
          )}
          {flow.kind === 'derive-received' && (
            <div className="sp-muted" style={{ fontSize: 11 }}>
              <Loader2 size={11} className="sp-spin" /> consent received; building delegation tx…
            </div>
          )}
          {flow.kind === 'constructing' && (
            <div className="sp-muted" style={{ fontSize: 11 }}>
              <Loader2 size={11} className="sp-spin" /> building AuthorizeDerivedKey tx…
            </div>
          )}
          {flow.kind === 'approve-window-open' && (
            <div className="sp-muted" style={{ fontSize: 11 }}>
              <Loader2 size={11} className="sp-spin" /> waiting for owner to sign the delegation
              tx in Identity…
            </div>
          )}
          {flow.kind === 'submitting' && (
            <div className="sp-muted" style={{ fontSize: 11 }}>
              <Loader2 size={11} className="sp-spin" /> submitting delegation tx to DeSo…
            </div>
          )}
          {flow.kind === 'verifying' && (
            <div className="sp-muted" style={{ fontSize: 11 }}>
              <Loader2 size={11} className="sp-spin" /> verifying on-chain (poll{' '}
              {flow.attempt + 1})…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
