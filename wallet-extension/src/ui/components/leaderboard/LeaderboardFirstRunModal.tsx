/**
 * one-time disclosure shown before the user enables the dWallet leaderboard.
 * spells out exactly what data leaves the device and what's read from chain
 * so opt-in is informed.
 */

export function LeaderboardFirstRunModal({
  onCancel,
  onAccept,
}: {
  onCancel: () => void;
  onAccept: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="leaderboard-disclosure-title"
      className="sp-modalOverlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        className="sp-modal"
        style={{
          maxWidth: 420,
          width: '100%',
          background: 'var(--ch-surface, #16181c)',
          borderRadius: 14,
          padding: 18,
          border: '1px solid rgba(234,240,255,0.06)',
        }}
      >
        <h3 id="leaderboard-disclosure-title" style={{ margin: '0 0 8px 0', fontSize: 14 }}>
          enable dWallet leaderboard?
        </h3>
        <p className="sp-muted" style={{ fontSize: 12, lineHeight: 1.5, margin: '0 0 8px 0' }}>
          this view ranks dWallets across the network by observed on-chain USD value.
          all reads are public Sui object queries plus public balance RPCs on each chain.
          nothing about you leaves your device; the list is built locally from on-chain data.
        </p>
        <ul className="sp-muted" style={{ fontSize: 11, lineHeight: 1.5, margin: '0 0 12px 16px', padding: 0 }}>
          <li>discovery: paginated <code>DWalletCap</code> objects on Sui (same data suivision/suiscan show).</li>
          <li>per-row USD: native + known SPL + 12 mainnet EVM chains, same probes the wallet runs for your own vault total.</li>
          <li>refresh tick fans out to many public RPCs at once. enable only when you're ok with that.</li>
          <li>policy-vault-wrapped caps and Solana-resident dWallets aren't enumerated yet.</li>
        </ul>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="sp-btn" onClick={onCancel}>
            cancel
          </button>
          <button type="button" className="sp-btn sp-btnPrimary" onClick={onAccept}>
            enable
          </button>
        </div>
      </div>
    </div>
  );
}
