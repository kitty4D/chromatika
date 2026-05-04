import { useCallback, useEffect, useState } from 'react';
import { Lock, LockOpen, Loader2, Receipt, ThumbsDown, ThumbsUp } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';

type Receipts = Awaited<ReturnType<typeof trpc.x402ListReceipts.query>>;
type ReceiptRow = Receipts[number];

interface DecryptedSet {
  [id: string]: { resourceUrl: string; sellerAddress: string; signatureHex: string | null };
}

const POLL_MS = 5_000;
const PAGE_LIMIT = 50;

function formatUsdc(atomic: string): string {
  try {
    const big = BigInt(atomic);
    const d = 6n;
    const whole = big / 10n ** d;
    const frac = big % 10n ** d;
    return `${whole.toString()}.${frac.toString().padStart(6, '0').replace(/0+$/, '') || '0'}`;
  } catch {
    return atomic;
  }
}

function relTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function statusClass(s: ReceiptRow['status']): string {
  switch (s) {
    case 'settled':
      return 'sp-x402StatusSettled';
    case 'pending':
      return 'sp-x402StatusPending';
    case 'failed':
      return 'sp-x402StatusFailed';
    case 'rejected':
      return 'sp-x402StatusRejected';
  }
}

/**
 * settings -> x402 receipts. read-only list of every payment the wallet has signed (or attempted).
 *
 * auto-refreshes every 5s so pending -> settled transitions show up live. capped at 50 most
 * recent rows (storage retention is 200, but the UI doesn't need more than a session's worth).
 * each row carries a thumbs-up / thumbs-down so the user can mark whether the response was
 * actually useful - future slices use this to seed allowlists / denylists.
 */
export function X402ReceiptsSection() {
  const [receipts, setReceipts] = useState<Receipts | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [decrypted, setDecrypted] = useState<DecryptedSet>({});
  const [decrypting, setDecrypting] = useState<string | null>(null);

  async function handleDecrypt(id: string) {
    setDecrypting(id);
    setMsg(null);
    try {
      const res = await trpc.decryptX402Receipt.mutate({ id });
      if (res.found) {
        setDecrypted((prev) => ({
          ...prev,
          [id]: {
            resourceUrl: res.resourceUrl,
            sellerAddress: res.sellerAddress,
            signatureHex: res.signatureHex,
          },
        }));
      } else {
        setMsg('receipt not found or has no encrypted blob');
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setDecrypting(null);
    }
  }

  function handleRelock(id: string) {
    setDecrypted((prev) => {
      const { [id]: _drop, ...rest } = prev;
      void _drop;
      return rest;
    });
  }

  const refresh = useCallback(async () => {
    try {
      const r = await trpc.x402ListReceipts.query({ limit: PAGE_LIMIT });
      setReceipts(r);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  async function setQuality(id: string, currentQuality: ReceiptRow['responseQuality'], next: 'good' | 'bad') {
    setBusy(true);
    setMsg(null);
    try {
      // toggle: clicking the same value clears it back to null.
      const target = currentQuality === next ? null : next;
      await trpc.x402SetReceiptQuality.mutate({ id, quality: target });
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!receipts) {
    return (
      <div className="sp-section">
        <h3>x402 receipts</h3>
        <div className="sp-muted">loading…</div>
      </div>
    );
  }

  if (receipts.length === 0) {
    return (
      <div className="sp-section">
        <h3>
          <Receipt size={12} style={{ marginRight: 6, verticalAlign: -1 }} />
          x402 receipts
        </h3>
        <p className="sp-muted">
          no x402 payments yet. once a page or agent hits a 402 endpoint and you approve in the
          popup, the receipt logs here. settlement digests fill in within a few seconds of the
          server returning <code>payment-response</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="sp-section">
      <h3>
        <Receipt size={12} style={{ marginRight: 6, verticalAlign: -1 }} />
        x402 receipts <span className="sp-muted" style={{ fontSize: 11, fontWeight: 400 }}>(last {receipts.length})</span>
      </h3>

      <div className="sp-x402Receipts">
        {receipts.map((r) => (
          <div key={r.id} className="sp-x402Receipt">
            <div className="sp-x402ReceiptTop">
              <span className={`sp-x402StatusBadge ${statusClass(r.status)}`}>{r.status}</span>
              <span className="sp-x402ReceiptHost" title={r.resourceUrl}>{r.sellerHost}</span>
              <span className="sp-x402ReceiptTime sp-muted">{relTime(r.enqueuedAtMs)}</span>
            </div>

            <div className="sp-x402ReceiptAmount">
              <span className="sp-x402ReceiptUsdc">${formatUsdc(r.amountAtomic)}</span>
              <span className="sp-muted" style={{ fontSize: 10, marginLeft: 4 }}>USDC</span>
              {r.amountUsdEstimate != null && (
                <span className="sp-muted" style={{ fontSize: 10, marginLeft: 6 }}>
                  ≈ ${r.amountUsdEstimate.toFixed(4)}
                </span>
              )}
            </div>

            {r.privateBlob && !decrypted[r.id] && (
              <div className="sp-x402ReceiptRow">
                <span className="sp-x402ReceiptLabel" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Lock size={10} /> private
                </span>
                <button
                  type="button"
                  className="sp-btn sp-btn--ghost"
                  onClick={() => void handleDecrypt(r.id)}
                  disabled={decrypting === r.id}
                  style={{ fontSize: 11, padding: '2px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  {decrypting === r.id ? <Loader2 size={11} className="sp-spin" /> : <LockOpen size={11} />}
                  {decrypting === r.id ? 'decrypting…' : 'decrypt resource + signature'}
                </button>
              </div>
            )}
            {decrypted[r.id] && (
              <>
                <div className="sp-x402ReceiptRow">
                  <span className="sp-x402ReceiptLabel">resource</span>
                  <span className="sp-x402ReceiptValue" title={decrypted[r.id].resourceUrl}>
                    {decrypted[r.id].resourceUrl}
                  </span>
                </div>
                <div className="sp-x402ReceiptRow">
                  <span className="sp-x402ReceiptLabel">seller</span>
                  <span className="sp-x402ReceiptValue" title={decrypted[r.id].sellerAddress}>
                    {decrypted[r.id].sellerAddress.slice(0, 12)}…{decrypted[r.id].sellerAddress.slice(-6)}
                  </span>
                  <button
                    type="button"
                    className="sp-btn sp-btn--ghost"
                    onClick={() => handleRelock(r.id)}
                    style={{ fontSize: 10, padding: '2px 6px', marginLeft: 6 }}
                  >
                    <Lock size={10} /> re-lock
                  </button>
                </div>
              </>
            )}
            {!r.privateBlob && r.resourceUrl && (
              <div className="sp-x402ReceiptRow">
                <span className="sp-x402ReceiptLabel">resource</span>
                <span className="sp-x402ReceiptValue" title={r.resourceUrl}>{r.resourceUrl}</span>
              </div>
            )}

            {r.settlementTxHash && (
              <div className="sp-x402ReceiptRow">
                <span className="sp-x402ReceiptLabel">tx</span>
                <ExplorerValueRow
                  fullValue={r.settlementTxHash}
                  href={null}
                  truncateMid={{ head: 8, tail: 8 }}
                  copyLabel="copy x402 settlement tx hash"
                  linkClassName="cd-explorerMonoPlain"
                />
              </div>
            )}

            {r.errorReason && (
              <div className="sp-x402ReceiptRow sp-x402ReceiptError">
                <span className="sp-x402ReceiptLabel">error</span>
                <span className="sp-x402ReceiptValue">{r.errorReason}</span>
              </div>
            )}

            <div className="sp-x402ReceiptActions">
              <button
                type="button"
                className={`sp-btn sp-x402Thumb ${r.responseQuality === 'good' ? 'sp-x402ThumbActiveGood' : ''}`}
                onClick={() => void setQuality(r.id, r.responseQuality, 'good')}
                disabled={busy}
                title="mark response as useful (informs future allowlists)"
                aria-label="mark response good"
              >
                <ThumbsUp size={11} />
              </button>
              <button
                type="button"
                className={`sp-btn sp-x402Thumb ${r.responseQuality === 'bad' ? 'sp-x402ThumbActiveBad' : ''}`}
                onClick={() => void setQuality(r.id, r.responseQuality, 'bad')}
                disabled={busy}
                title="mark response as not useful (informs future denylists)"
                aria-label="mark response bad"
              >
                <ThumbsDown size={11} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {msg && <div className="sp-msg">{msg}</div>}
    </div>
  );
}
