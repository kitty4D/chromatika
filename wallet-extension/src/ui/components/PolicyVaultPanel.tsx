/**
 * policy vault settings panel: on-chain spend caps + panic button + rescue address + the
 * two-step unwrap exit path.
 *
 * three states:
 *   1. **not configured**: no built-in Policy Vault package is available for the active
 *      network (and no iteration override is set). End users see an informational message
 *      pointing at the trust writeup; chromatika team during testing can expand the
 *      "team only" details to point at a non-`:final` iteration deploy.
 *   2. **configured, not opted in**: package details (id, audit hash, "upgrade authority
 *      burned" badge) + "Opt in" button which opens a config modal.
 *   3. **opted in**: status (panicked / active), daily cap + spent today, actuators,
 *      rescue address, tune settings, big PANIC button, and the two-step unwrap section
 *      (request -> wait stage delay -> claim) that returns the dWallet cap to the user
 *      and consumes the on-chain vault.
 *
 * mounted under SettingsPage. settings -> security -> "On-chain spend caps + panic".
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  History,
  Loader2,
  Lock,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  TimerReset,
  Trash2,
  Unlock,
  Users,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { microsToUsd, fmtMs, fmtMist } from './policy-vault-format';

type PolicyState = Awaited<ReturnType<typeof trpc.getPolicyVaultState.query>>;
type AuditEntry = Awaited<ReturnType<typeof trpc.getPolicyAuditEntries.query>>['entries'][number];

const AUDIT_KIND_LABELS: Record<AuditEntry['kind'], string> = {
  'opt-in': 'opt in',
  panic: 'PANIC',
  unfreeze: 'unfreeze',
  'set-daily-cap': 'set daily cap',
  'set-cool-down': 'set cool-down',
  'set-rescue-address': 'set rescue address',
  'add-actuator': 'add actuator',
  'remove-actuator': 'remove actuator',
  'replenish-presign': 'replenish presign',
  'top-up-ika': 'top up IKA',
  'top-up-sui': 'top up SUI',
  'sign-cap-applied': 'sign (within cap)',
  'sign-aborted-over-cap': 'sign aborted (over cap)',
  'sign-aborted-panicked': 'sign aborted (panicked)',
  'sign-aborted-cool-down': 'sign aborted (cool-down)',
  'local-link-cleared': 'local link cleared',
  // staged-delay opt-in safety
  'stage-cap-raises-toggled': 'staging toggled',
  'pending-cap-staged': 'cap raise STAGED',
  'pending-cap-committed': 'cap raise COMMITTED',
  'pending-stage-off-staged': 'staging-off STAGED',
  'pending-stage-off-committed': 'staging-off COMMITTED',
  'set-stage-delay': 'set stage delay',
  // unwrap two-step
  'unwrap-requested': 'unwrap requested',
  'unwrap-cancelled': 'unwrap cancelled',
  'vault-unwrapped': 'vault UNWRAPPED',
};

const DEFAULT_OPTIN = {
  dailyCapUsd: '1000',
  coolDownSec: '60',
  unfreezeDelayDays: '7',
  stageDelayHours: '24', // default stage delay (24h); only matters once staging is opted in
  rescueAddress: '',
  initialIkaMist: '10000000', // 0.01 IKA
  initialSuiMist: '10000000', // 0.01 SUI
};

/** policy panel state snapshot (dev `policyPanelDemo` frozen panel). */
export type PolicyVaultPanelState = PolicyState;

export function PolicyVaultPanel({ freezeDemoState }: { freezeDemoState?: PolicyVaultPanelState } = {}) {
  const isFrozenDemo = freezeDemoState !== undefined;
  const [state, setState] = useState<PolicyState | null>(() =>
    freezeDemoState !== undefined ? freezeDemoState : null,
  );
  const [auditEntries, setAuditEntries] = useState<AuditEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [packageInput, setPackageInput] = useState('');
  const [optInOpen, setOptInOpen] = useState(false);
  const [optIn, setOptIn] = useState({ ...DEFAULT_OPTIN });
  const [actuatorInput, setActuatorInput] = useState('');
  const [rescueDraft, setRescueDraft] = useState('');
  const [capDraftUsd, setCapDraftUsd] = useState('');
  const [coolDraftSec, setCoolDraftSec] = useState('');
  const [stageDelayDraftHours, setStageDelayDraftHours] = useState('');
  const [confirmPanic, setConfirmPanic] = useState(false);
  const [tickMs, setTickMs] = useState(Date.now());

  const refresh = useCallback(async () => {
    if (isFrozenDemo && freezeDemoState !== undefined) {
      setState(freezeDemoState);
      setAuditEntries([]);
      setErr(null);
      return;
    }
    try {
      const s = await trpc.getPolicyVaultState.query();
      setState(s);
      // refresh audit for the primary wrapped dwallet (first link) since the panel
      // currently surfaces it.
      const primaryDwallet = s?.links?.[0]?.link?.dwalletId ?? null;
      if (primaryDwallet) {
        try {
          const r = await trpc.getPolicyAuditEntries.query({ dwalletId: primaryDwallet, limit: 50 });
          setAuditEntries(r.entries);
        } catch {
          /* best-effort */
        }
      } else {
        setAuditEntries([]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [isFrozenDemo, freezeDemoState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // live tick for the unfreeze countdown.
  useEffect(() => {
    const t = setInterval(() => setTickMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>, successMsg?: string) => {
      if (isFrozenDemo) {
        setErr(null);
        setMsg(null);
        return;
      }
      setBusy(label);
      setErr(null);
      setMsg(null);
      try {
        await fn();
        if (successMsg) setMsg(successMsg);
        await refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh, isFrozenDemo],
  );

  if (!state) {
    return (
      <section className="sp-settingsSection">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldCheck size={14} /> on-chain spend caps + panic button
        </h3>
        <div className="sp-muted" style={{ fontSize: 11 }}>
          <Loader2 size={11} className="sp-spin" /> loading policy state...
        </div>
      </section>
    );
  }

  // Policy Vault is Sui-only today. The Solana Anchor program at
  // `solana/chromatika-policy/` is pre-alpha scaffolding (CPI bodies stub to
  // no-ops pending ika Solana Alpha-1), so the panel reads as disabled when the
  // active vault is Solana-base instead of offering an opt-in we can't honor.
  if (state.activeVaultBaseChain === 'solana') {
    return (
      <section className="sp-settingsSection">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldOff size={14} /> on-chain spend caps + panic button
        </h3>
        <div style={{ padding: 8, background: 'var(--theme-banner-warn-bg, rgba(251, 191, 36, 0.18))', borderRadius: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Policy Vault is Sui-only for now
          </div>
          <p className="sp-muted" style={{ fontSize: 11, margin: 0 }}>
            The Solana-base policy module is pre-alpha scaffolding pending the ika Solana
            Alpha-1 CPI surface (today it would be a no-op signer). Switch to a Sui-base
            vault to opt in to on-chain spend caps + panic + rescue. See{' '}
            <code>wallet-extension/docs/POLICY_VAULT.md</code>.
          </p>
        </div>
      </section>
    );
  }

  const cfg = state.packageConfig;
  // Multi-dwallet wraps are supported by the storage + action layer; the panel
  // currently surfaces the first wrapped dwallet for management. A per-dwallet
  // selector lands in a follow-up. Other wraps stay manageable via their own
  // post-create prompts; the on-chain state is independent per dwallet.
  const primary = state.links?.[0];
  const link = primary?.link ?? null;
  const snap = primary?.snapshot ?? null;
  const additionalWrapCount = Math.max(0, (state.links?.length ?? 0) - 1);

  return (
    <section className="sp-settingsSection">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {snap?.panicked ? <ShieldAlert size={14} color="#ef4444" /> : <ShieldCheck size={14} />}
        on-chain spend caps + panic button
      </h3>

      <p className="sp-muted" style={{ fontSize: 12, margin: '0 0 8px 0' }}>
        Wraps a dWallet cap (SECP256K1 or ED25519) in a Sui Move policy module. After opt-in,
        every signature must pass the on-chain cap, cool-down, and non-panicked check before
        the ika MPC network issues it. The popup stops being your only line of defense.
      </p>

      {err && (
        <div className="sp-error" style={{ marginBottom: 6, fontSize: 11 }}>
          <AlertTriangle size={11} /> {err}
        </div>
      )}
      {msg && (
        <div className="sp-muted" style={{ fontSize: 11, color: 'var(--theme-banner-success-fg, oklch(0.78 0.16 152))', marginBottom: 6 }}>
          {msg}
        </div>
      )}

      {/* state 1: no built-in package available for this network (or team override unset) */}
      {!cfg && (
        <div style={{ padding: 8, background: 'var(--theme-banner-warn-bg, rgba(251, 191, 36, 0.18))', borderRadius: 4, marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Policy package not available on this network
          </div>
          <p className="sp-muted" style={{ fontSize: 11, margin: '0 0 6px 0' }}>
            Chromatika ships built-in, audited, immutable Policy Vault packages per network.
            None is available for your active network yet. The team will publish the production
            cut alongside the next chromatika release. Once shipped, the panel here will show
            the active package id, audit hash, and audit report link automatically. Read the
            trust story at <code>local/wallet-special/policy-vault-deployment.md</code>.
          </p>
          <details style={{ marginTop: 6 }}>
            <summary style={{ fontSize: 10, cursor: 'pointer', color: 'var(--faint)' }}>
              chromatika team only: point at an iteration deploy
            </summary>
            <p className="sp-muted" style={{ fontSize: 10, margin: '6px 0 4px 0' }}>
              During testing, the team can run <code>pnpm run deploy:sui-policy:&lt;env&gt;</code>
              (without <code>:final</code>) to get a mutable iteration package, then paste the
              printed id here. Production cuts use <code>:final</code> and ship via the built-in
              registry instead. End users never see this input.
            </p>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                className="sp-input"
                value={packageInput}
                onChange={(e) => setPackageInput(e.target.value)}
                placeholder="0x... (32-byte hex Sui package id, iteration deploy only)"
                style={{ flex: 1, fontSize: 11, fontFamily: 'monospace' }}
              />
              <button
                type="button"
                className="sp-btn sp-btn--primary"
                onClick={() =>
                  void run(
                    'set-package',
                    () => trpc.setPolicyPackageId.mutate({ packageId: packageInput.trim() }),
                    'package id saved (iteration override)',
                  )
                }
                disabled={busy !== null || !/^0x[0-9a-fA-F]{64}$/.test(packageInput.trim())}
              >
                {busy === 'set-package' ? <Loader2 size={11} className="sp-spin" /> : 'save'}
              </button>
            </div>
          </details>
        </div>
      )}

      {/* state 2: configured but not opted in */}
      {cfg && !link && (
        <div style={{ padding: 8, background: 'color-mix(in oklch, var(--surface, oklch(0.22 0.045 285)) 45%, transparent)', borderRadius: 4, marginBottom: 8 }}>
          <div style={{ fontSize: 11, marginBottom: 4 }}>
            package: <code style={{ fontFamily: 'monospace' }}>{cfg.packageId.slice(0, 14)}...</code>
            <button
              type="button"
              className="sp-btn sp-btn--ghost"
              onClick={() =>
                void run('clear-pkg', () => trpc.clearPolicyPackageId.mutate(), 'package cleared')
              }
              style={{ marginLeft: 6, fontSize: 10, padding: '1px 4px' }}
            >
              clear
            </button>
          </div>
          {!optInOpen ? (
            <button
              type="button"
              className="sp-btn sp-btn--primary"
              onClick={() => setOptInOpen(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Lock size={11} /> opt in: wrap dWallet cap into PolicyVault
            </button>
          ) : (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>configure policy</div>
              <Field
                label="daily cap (USD)"
                hint="Most USD this dWallet can authorize in any rolling 24h. Lower = safer. Raises wait the staged-change delay (below); decreases apply immediately. 0 disables the cap entirely (panic + cool-down still apply)."
              >
                <input
                  type="text"
                  className="sp-input"
                  value={optIn.dailyCapUsd}
                  onChange={(e) => setOptIn({ ...optIn, dailyCapUsd: e.target.value })}
                  placeholder="1000 (0 = no cap)"
                  style={{ fontSize: 11 }}
                />
              </Field>
              <Field
                label="cool-down between sends (sec)"
                hint="Minimum gap between two successful signatures. Slows a stolen key from burst-draining the cap. 60 seconds is a comfortable floor; 0 disables."
              >
                <input
                  type="text"
                  className="sp-input"
                  value={optIn.coolDownSec}
                  onChange={(e) => setOptIn({ ...optIn, coolDownSec: e.target.value })}
                  placeholder="60 (0 = none)"
                  style={{ fontSize: 11 }}
                />
              </Field>
              <Field
                label="unfreeze delay after panic (days)"
                hint="After hitting panic, how long signing stays blocked. The wait is the security feature: time for you to rotate compromised keys and for watchers to react. Any actuator can re-panic before the delay elapses to extend the freeze."
              >
                <input
                  type="text"
                  className="sp-input"
                  value={optIn.unfreezeDelayDays}
                  onChange={(e) => setOptIn({ ...optIn, unfreezeDelayDays: e.target.value })}
                  placeholder="7"
                  style={{ fontSize: 11 }}
                />
              </Field>
              <Field
                label="stage-cap-raises delay (hours)"
                hint="Also the unwrap delay. Used by the optional cap-staging safety net (OFF by default; toggle on under 'tune' once opted in). Cap raises then wait this long before taking effect; cap decreases stay immediate. Unwrap (turning the policy off) always waits this duration."
              >
                <input
                  type="text"
                  className="sp-input"
                  value={optIn.stageDelayHours}
                  onChange={(e) => setOptIn({ ...optIn, stageDelayHours: e.target.value })}
                  placeholder="24"
                  style={{ fontSize: 11 }}
                />
              </Field>
              <Field
                label="rescue address (drain dest while panicked) (optional)"
                hint="Where leftover IKA + SUI inside the vault gets drained if you hit panic and want to evacuate. Use a hardware wallet or cold storage address. Leave blank to set later from the live panel."
              >
                <input
                  type="text"
                  className="sp-input"
                  value={optIn.rescueAddress}
                  onChange={(e) => setOptIn({ ...optIn, rescueAddress: e.target.value })}
                  placeholder="0x... (your hardware wallet / cold storage)"
                  style={{ fontSize: 11, fontFamily: 'monospace' }}
                />
              </Field>
              <Field
                label="initial IKA fund (mist)"
                hint="Seed IKA the vault uses to pay ika protocol fees for its own signing tx. Topped up later from this panel. 10_000_000 mist = 0.01 IKA = plenty for hundreds of signs."
              >
                <input
                  type="text"
                  className="sp-input"
                  value={optIn.initialIkaMist}
                  onChange={(e) => setOptIn({ ...optIn, initialIkaMist: e.target.value })}
                  style={{ fontSize: 11 }}
                />
              </Field>
              <Field
                label="initial SUI fund (mist)"
                hint="Seed SUI the vault uses to pay Sui gas for its own signing tx. Topped up later from this panel. 10_000_000 mist = 0.01 SUI = plenty for hundreds of signs."
              >
                <input
                  type="text"
                  className="sp-input"
                  value={optIn.initialSuiMist}
                  onChange={(e) => setOptIn({ ...optIn, initialSuiMist: e.target.value })}
                  style={{ fontSize: 11 }}
                />
              </Field>
              <div className="sp-muted" style={{ fontSize: 10, margin: '6px 0 4px 0' }}>
                Heads up: opting in transfers the dWallet cap into a shared object. After this,
                ALL signing for this dWallet must go through the policy module. Wallet UI
                signing may break until v1 wires the send paths through sign_with_policy.
                Only opt in on a vault you can rebuild from a backup if needed.
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="sp-btn sp-btn--primary"
                  onClick={() =>
                    void run(
                      'opt-in',
                      () =>
                        trpc.optInToPolicyVault.mutate({
                          dailyCapMicros: String(BigInt(Math.round(parseFloat(optIn.dailyCapUsd || '0') * 1_000_000))),
                          coolDownMs: String(BigInt(Math.round(parseFloat(optIn.coolDownSec || '0') * 1000))),
                          unfreezeDelayMs: String(
                            BigInt(Math.round(parseFloat(optIn.unfreezeDelayDays || '0') * 86_400_000)),
                          ),
                          stageDelayMs: String(
                            BigInt(Math.round(parseFloat(optIn.stageDelayHours || '24') * 3_600_000)),
                          ),
                          rescueAddress: optIn.rescueAddress.trim() || undefined,
                          initialIkaMist: optIn.initialIkaMist || '0',
                          initialSuiMist: optIn.initialSuiMist || '0',
                        }),
                      'opted in. dWallet cap is now policy-gated.',
                    ).then(() => setOptInOpen(false))
                  }
                  disabled={busy !== null}
                >
                  {busy === 'opt-in' ? <Loader2 size={11} className="sp-spin" /> : 'opt in (sign Sui tx)'}
                </button>
                <button
                  type="button"
                  className="sp-btn sp-btn--ghost"
                  onClick={() => setOptInOpen(false)}
                  disabled={busy !== null}
                >
                  cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* state 3: opted in */}
      {cfg && link && (
        <div>
          {/* status banner */}
          <div
            style={{
              padding: 8,
              background: snap?.panicked
                ? 'rgba(239,68,68,0.15)'
                : 'rgba(134,239,172,0.10)',
              borderRadius: 4,
              marginBottom: 8,
              border: snap?.panicked ? '1px solid rgba(239,68,68,0.4)' : '1px solid transparent',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
              {snap?.panicked ? (
                <>
                  <ShieldOff size={14} color="#ef4444" /> PANICKED: all signing frozen
                </>
              ) : (
                <>
                  <ShieldCheck size={14} color="#86efac" /> active
                </>
              )}
            </div>
            {snap?.panicked && snap.unfreezeUnlocksAtMs > 0 && (
              <div className="sp-muted" style={{ fontSize: 11, marginTop: 4 }}>
                <TimerReset size={11} /> unfreeze unlocks in{' '}
                {fmtMs(snap.unfreezeUnlocksAtMs - tickMs)} (delay configured at{' '}
                {fmtMs(snap.unfreezeDelayMs)})
              </div>
            )}
          </div>

          {additionalWrapCount > 0 && (
            <div
              className="sp-muted"
              style={{
                fontSize: 10,
                marginBottom: 6,
                padding: '4px 6px',
                background: 'rgba(255,255,255,0.04)',
                borderRadius: 3,
              }}
            >
              Showing the first wrapped dWallet ({curveLabel(link.curve)}).{' '}
              {additionalWrapCount} other
              {additionalWrapCount === 1 ? ' dWallet is' : ' dWallets are'} also wrapped on this
              vault; per-dWallet selector is a follow-up. On-chain state is independent per wrap.
            </div>
          )}

          {/* vault id + refresh */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 6, flexWrap: 'wrap' }}>
            <span className="sp-muted">vault:</span>
            <code style={{ fontFamily: 'monospace', fontSize: 10 }}>{link.vaultObjectId.slice(0, 14)}...</code>
            <button
              type="button"
              className="sp-btn sp-btn--ghost"
              onClick={() => void navigator.clipboard.writeText(link.vaultObjectId)}
              style={{ fontSize: 10, padding: '1px 4px', display: 'inline-flex', alignItems: 'center', gap: 3 }}
            >
              <Copy size={10} /> copy
            </button>
            <a
              href={`https://suiscan.xyz/object/${link.vaultObjectId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="sp-btn sp-btn--ghost"
              style={{ fontSize: 10, padding: '1px 4px', display: 'inline-flex', alignItems: 'center', gap: 3 }}
            >
              <ExternalLink size={10} /> explorer
            </a>
            <button
              type="button"
              className="sp-btn sp-btn--ghost"
              onClick={() => void refresh()}
              style={{ marginLeft: 'auto', fontSize: 10, padding: '1px 4px', display: 'inline-flex', alignItems: 'center', gap: 3 }}
            >
              <RefreshCw size={10} /> refresh
            </button>
          </div>

          {/* pending state visualization (cap raise / stage-off) */}
          {snap && (snap.hasPendingCap || snap.pendingStageOff) && (
            <div
              style={{
                padding: 8,
                background: 'rgba(255,196,77,0.10)',
                border: '1px solid rgba(255,196,77,0.4)',
                borderRadius: 4,
                marginBottom: 8,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                <TimerReset size={11} /> pending changes
              </div>
              {snap.hasPendingCap && (
                <div style={{ fontSize: 11, marginBottom: 4 }}>
                  cap raise:{' '}
                  <strong>${microsToUsd(snap.dailyCapMicros)}</strong> →{' '}
                  <strong>${microsToUsd(snap.pendingCapMicros)}</strong>
                  {' · '}
                  {tickMs >= snap.pendingCapAtMs ? (
                    <span style={{ color: 'var(--theme-banner-success-fg, oklch(0.78 0.16 152))' }}>delay elapsed — commit available</span>
                  ) : (
                    <span className="sp-muted">commits in {fmtMs(snap.pendingCapAtMs - tickMs)}</span>
                  )}
                  {tickMs >= snap.pendingCapAtMs && (
                    <button
                      type="button"
                      className="sp-btn"
                      onClick={() =>
                        void run(
                          'commit-cap',
                          () => trpc.commitPendingPolicyCap.mutate({ dwalletId: link.dwalletId }),
                          'pending cap committed',
                        )
                      }
                      disabled={busy !== null}
                      style={{ fontSize: 10, padding: '1px 6px', marginLeft: 6 }}
                    >
                      {busy === 'commit-cap' ? <Loader2 size={10} className="sp-spin" /> : 'commit now'}
                    </button>
                  )}
                </div>
              )}
              {snap.pendingStageOff && (
                <div style={{ fontSize: 11 }}>
                  staging-off:{' '}
                  {tickMs >= snap.pendingStageOffAtMs ? (
                    <span style={{ color: 'var(--theme-banner-success-fg, oklch(0.78 0.16 152))' }}>delay elapsed — commit available</span>
                  ) : (
                    <span className="sp-muted">
                      commits in {fmtMs(snap.pendingStageOffAtMs - tickMs)}
                    </span>
                  )}
                  {tickMs >= snap.pendingStageOffAtMs && (
                    <button
                      type="button"
                      className="sp-btn"
                      onClick={() =>
                        void run(
                          'commit-stage-off',
                          () => trpc.commitPendingPolicyStageOff.mutate({ dwalletId: link.dwalletId }),
                          'staging-off committed',
                        )
                      }
                      disabled={busy !== null}
                      style={{ fontSize: 10, padding: '1px 6px', marginLeft: 6 }}
                    >
                      {busy === 'commit-stage-off' ? (
                        <Loader2 size={10} className="sp-spin" />
                      ) : (
                        'commit now'
                      )}
                    </button>
                  )}
                </div>
              )}
              <div className="sp-muted" style={{ fontSize: 9, marginTop: 4 }}>
                Pending changes also commit lazily on the next signed transaction. The "commit
                now" button is for explicit checkpoints.
              </div>
            </div>
          )}

          {/* daily cap + spent */}
          {snap && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, marginBottom: 2 }}>
                daily cap: <strong>${microsToUsd(snap.dailyCapMicros)}</strong>
                {' '}· spent today: <strong>${microsToUsd(snap.spentTodayMicros)}</strong>
                {snap.dailyCapMicros !== '0' && (
                  <>
                    {' '}· remaining:{' '}
                    <strong>
                      $
                      {microsToUsd(
                        (BigInt(snap.dailyCapMicros) - BigInt(snap.spentTodayMicros) > 0n
                          ? BigInt(snap.dailyCapMicros) - BigInt(snap.spentTodayMicros)
                          : 0n
                        ).toString(),
                      )}
                    </strong>
                  </>
                )}
              </div>
              {snap.dailyCapMicros !== '0' && (
                <div
                  style={{
                    height: 4,
                    background: 'rgba(255,255,255,0.08)',
                    borderRadius: 2,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(
                        100,
                        (Number(BigInt(snap.spentTodayMicros)) /
                          Math.max(1, Number(BigInt(snap.dailyCapMicros)))) *
                          100,
                      ).toFixed(1)}%`,
                      background:
                        BigInt(snap.spentTodayMicros) >= BigInt(snap.dailyCapMicros)
                          ? '#ef4444'
                          : '#86efac',
                    }}
                  />
                </div>
              )}
              <div className="sp-muted" style={{ fontSize: 10, marginTop: 2 }}>
                cool-down: {fmtMs(snap.coolDownMs)} · presigns remaining: {snap.presignsRemaining}
                {' '}· vault IKA: {fmtMist(snap.ikaBalance)} · vault SUI: {fmtMist(snap.suiBalance)}
              </div>
            </div>
          )}

          {/* actuators */}
          {snap && (
            <details style={{ marginBottom: 8 }}>
              <summary style={{ fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                <Users size={11} /> actuators ({snap.actuators.length})
              </summary>
              <div style={{ marginTop: 4, paddingLeft: 8 }}>
                {snap.actuators.map((a) => (
                  <div
                    key={a}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 10,
                      fontFamily: 'monospace',
                      marginBottom: 2,
                    }}
                  >
                    {a.slice(0, 14)}...{a.slice(-6)}
                    {a !== link.primaryActuator && snap.actuators.length > 1 && !snap.panicked && (
                      <button
                        type="button"
                        className="sp-btn sp-btn--ghost"
                        onClick={() =>
                          void run(
                            'remove-actuator',
                            () => trpc.removePolicyActuator.mutate({ dwalletId: link.dwalletId, target: a }),
                            'actuator removed',
                          )
                        }
                        style={{ fontSize: 10, padding: '0 4px' }}
                        disabled={busy !== null}
                      >
                        x
                      </button>
                    )}
                  </div>
                ))}
                {!snap.panicked && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                    <input
                      type="text"
                      className="sp-input"
                      value={actuatorInput}
                      onChange={(e) => setActuatorInput(e.target.value)}
                      placeholder="0x... new actuator (friend / chromatika-team)"
                      style={{ fontSize: 10, fontFamily: 'monospace', flex: 1 }}
                    />
                    <button
                      type="button"
                      className="sp-btn sp-btn--ghost"
                      onClick={() =>
                        void run(
                          'add-actuator',
                          () => trpc.addPolicyActuator.mutate({ dwalletId: link.dwalletId, newActuator: actuatorInput.trim() }),
                          'actuator added',
                        ).then(() => setActuatorInput(''))
                      }
                      disabled={busy !== null || !/^0x[0-9a-fA-F]{64}$/.test(actuatorInput.trim())}
                      style={{ fontSize: 10 }}
                    >
                      add
                    </button>
                  </div>
                )}
                <div className="sp-muted" style={{ fontSize: 9, marginTop: 4 }}>
                  Any actuator can panic the vault. Add a friend address for social recovery,
                  or chromatika-team's address for safety-alert auto-panic.
                </div>
              </div>
            </details>
          )}

          {/* settings (cap, cool-down, rescue): disabled while panicked */}
          {snap && !snap.panicked && (
            <details style={{ marginBottom: 8 }}>
              <summary style={{ fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                <SettingsIcon size={11} /> tune
              </summary>
              <div style={{ paddingLeft: 8, marginTop: 4 }}>
                <Field label="new daily cap (USD)">
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input
                      type="text"
                      className="sp-input"
                      value={capDraftUsd}
                      onChange={(e) => setCapDraftUsd(e.target.value)}
                      placeholder={microsToUsd(snap.dailyCapMicros)}
                      style={{ flex: 1, fontSize: 11 }}
                    />
                    <button
                      type="button"
                      className="sp-btn"
                      onClick={() =>
                        void run(
                          'set-cap',
                          () =>
                            trpc.setPolicyDailyCap.mutate({
                              dwalletId: link.dwalletId,
                              newCapMicros: String(BigInt(Math.round(parseFloat(capDraftUsd || '0') * 1_000_000))),
                            }),
                          'cap updated',
                        ).then(() => setCapDraftUsd(''))
                      }
                      disabled={busy !== null || capDraftUsd.length === 0}
                      style={{ fontSize: 11 }}
                    >
                      save
                    </button>
                  </div>
                </Field>
                <Field label="new cool-down (sec)">
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input
                      type="text"
                      className="sp-input"
                      value={coolDraftSec}
                      onChange={(e) => setCoolDraftSec(e.target.value)}
                      placeholder={String(Math.round(snap.coolDownMs / 1000))}
                      style={{ flex: 1, fontSize: 11 }}
                    />
                    <button
                      type="button"
                      className="sp-btn"
                      onClick={() =>
                        void run(
                          'set-cool',
                          () =>
                            trpc.setPolicyCoolDown.mutate({
                              dwalletId: link.dwalletId,
                              newCoolDownMs: String(
                                BigInt(Math.round(parseFloat(coolDraftSec || '0') * 1000)),
                              ),
                            }),
                          'cool-down updated',
                        ).then(() => setCoolDraftSec(''))
                      }
                      disabled={busy !== null || coolDraftSec.length === 0}
                      style={{ fontSize: 11 }}
                    >
                      save
                    </button>
                  </div>
                </Field>
                <Field label="rescue address (drain dest while panicked)">
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input
                      type="text"
                      className="sp-input"
                      value={rescueDraft}
                      onChange={(e) => setRescueDraft(e.target.value)}
                      placeholder={snap.hasRescueAddress ? '(set; enter new or empty to clear)' : '0x...'}
                      style={{ flex: 1, fontSize: 11, fontFamily: 'monospace' }}
                    />
                    <button
                      type="button"
                      className="sp-btn"
                      onClick={() =>
                        void run(
                          'set-rescue',
                          () =>
                            trpc.setPolicyRescueAddress.mutate({
                              dwalletId: link.dwalletId,
                              rescueAddress: rescueDraft.trim() || undefined,
                            }),
                          'rescue address updated',
                        ).then(() => setRescueDraft(''))
                      }
                      disabled={busy !== null}
                      style={{ fontSize: 11 }}
                    >
                      save
                    </button>
                  </div>
                </Field>
                {/* stage cap raises toggle (opt-in safety). */}
                <div
                  style={{
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <strong style={{ fontSize: 11 }}>stage cap raises</strong>
                    <span
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: snap.stageCapRaises ? 'rgba(134,239,172,0.18)' : 'rgba(255,255,255,0.06)',
                        color: snap.stageCapRaises ? '#86efac' : 'inherit',
                      }}
                    >
                      {snap.stageCapRaises ? 'ON' : 'OFF'}
                    </span>
                    <span className="sp-muted" style={{ fontSize: 10 }}>
                      delay: {fmtMs(snap.stageDelayMs)}
                    </span>
                    <button
                      type="button"
                      className="sp-btn"
                      onClick={() =>
                        void run(
                          'toggle-stage',
                          () =>
                            trpc.setPolicyStageCapRaises.mutate({ dwalletId: link.dwalletId, next: !snap.stageCapRaises }),
                          snap.stageCapRaises
                            ? 'staging-off requested (will stage for delay)'
                            : 'staging is now ON',
                        )
                      }
                      disabled={busy !== null || snap.pendingStageOff}
                      style={{ marginLeft: 'auto', fontSize: 10, padding: '1px 6px' }}
                    >
                      {busy === 'toggle-stage' ? (
                        <Loader2 size={10} className="sp-spin" />
                      ) : snap.stageCapRaises ? (
                        'turn OFF (staged)'
                      ) : (
                        'turn ON'
                      )}
                    </button>
                  </div>
                  <div className="sp-muted" style={{ fontSize: 10, marginBottom: 4 }}>
                    When ON, cap RAISES wait the delay before taking effect; cap decreases stay
                    immediate. Turning OFF is itself staged (symmetric protection — a compromised
                    chromatika can't trivially disable the safety net before you notice).
                  </div>
                  <Field label="new stage delay (hours)">
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input
                        type="text"
                        className="sp-input"
                        value={stageDelayDraftHours}
                        onChange={(e) => setStageDelayDraftHours(e.target.value)}
                        placeholder={String(Math.round(snap.stageDelayMs / 3_600_000))}
                        style={{ flex: 1, fontSize: 11 }}
                      />
                      <button
                        type="button"
                        className="sp-btn"
                        onClick={() =>
                          void run(
                            'set-stage-delay',
                            () =>
                              trpc.setPolicyStageDelayMs.mutate({
                                dwalletId: link.dwalletId,
                                newDelayMs: String(
                                  BigInt(
                                    Math.round(parseFloat(stageDelayDraftHours || '0') * 3_600_000),
                                  ),
                                ),
                              }),
                            'stage delay updated',
                          ).then(() => setStageDelayDraftHours(''))
                        }
                        disabled={busy !== null || stageDelayDraftHours.length === 0}
                        style={{ fontSize: 11 }}
                      >
                        save
                      </button>
                    </div>
                  </Field>
                </div>
              </div>
            </details>
          )}

          {/* replenish presigns */}
          {snap && !snap.panicked && snap.presignsRemaining < 3 && (
            <button
              type="button"
              className="sp-btn sp-btn--ghost"
              onClick={() =>
                void run(
                  'replenish',
                  () => trpc.replenishPolicyPresign.mutate({ dwalletId: link.dwalletId }),
                  'presign added',
                )
              }
              disabled={busy !== null}
              style={{ fontSize: 11, marginBottom: 8 }}
            >
              {busy === 'replenish' ? <Loader2 size={11} className="sp-spin" /> : <RefreshCw size={11} />}
              replenish presign ({snap.presignsRemaining} in pool)
            </button>
          )}

          {/* PANIC */}
          {snap && !snap.panicked && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border, rgba(255,255,255,0.08))' }}>
              {!confirmPanic ? (
                <button
                  type="button"
                  className="sp-btn"
                  onClick={() => setConfirmPanic(true)}
                  style={{
                    background: 'rgba(239,68,68,0.15)',
                    color: 'oklch(0.6 0.22 25)',
                    border: '1px solid rgba(239,68,68,0.4)',
                    width: '100%',
                    fontSize: 13,
                    padding: '8px 12px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  <ShieldAlert size={14} /> PANIC: freeze all signing
                </button>
              ) : (
                <div
                  style={{
                    background: 'rgba(239,68,68,0.10)',
                    padding: 8,
                    borderRadius: 4,
                    border: '1px solid rgba(239,68,68,0.4)',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'oklch(0.6 0.22 25)', marginBottom: 4 }}>
                    confirm: this freezes ALL chromatika signing for this dWallet on-chain
                  </div>
                  <div className="sp-muted" style={{ fontSize: 10, marginBottom: 6 }}>
                    Unfreeze takes {fmtMs(snap.unfreezeDelayMs)} after panic. Only the rescue
                    path works while panicked. Use this if you suspect the vault is compromised
                    or chromatika has been hijacked.
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="sp-btn"
                      onClick={() =>
                        void run('panic', () => trpc.panicVault.mutate({ dwalletId: link.dwalletId }), 'panic active').then(() =>
                          setConfirmPanic(false),
                        )
                      }
                      disabled={busy !== null}
                      style={{ background: 'oklch(0.6 0.22 25)', color: 'white', flex: 1 }}
                    >
                      {busy === 'panic' ? <Loader2 size={11} className="sp-spin" /> : 'YES, PANIC NOW'}
                    </button>
                    <button
                      type="button"
                      className="sp-btn sp-btn--ghost"
                      onClick={() => setConfirmPanic(false)}
                      disabled={busy !== null}
                    >
                      cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* unfreeze */}
          {snap && snap.panicked && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="sp-btn"
                onClick={() => void run('unfreeze', () => trpc.unfreezeVault.mutate({ dwalletId: link.dwalletId }), 'unfrozen')}
                disabled={busy !== null || tickMs < snap.unfreezeUnlocksAtMs}
                style={{
                  background:
                    tickMs >= snap.unfreezeUnlocksAtMs ? '#86efac' : 'rgba(134,239,172,0.2)',
                  color: tickMs >= snap.unfreezeUnlocksAtMs ? '#0c1f0e' : '#86efac',
                  width: '100%',
                  fontSize: 13,
                  padding: '8px 12px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                {busy === 'unfreeze' ? (
                  <Loader2 size={11} className="sp-spin" />
                ) : tickMs >= snap.unfreezeUnlocksAtMs ? (
                  <Unlock size={14} />
                ) : (
                  <TimerReset size={14} />
                )}
                {tickMs >= snap.unfreezeUnlocksAtMs
                  ? 'UNFREEZE: clear panic flag'
                  : `unfreeze locked for ${fmtMs(snap.unfreezeUnlocksAtMs - tickMs)}`}
              </button>
            </div>
          )}

          {/* audit log: every policy decision the user has made through chromatika. */}
          <details style={{ marginTop: 10 }}>
            <summary style={{ fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <History size={11} /> audit log ({auditEntries?.length ?? 0})
            </summary>
            <div style={{ marginTop: 6, paddingLeft: 6 }}>
              <p className="sp-muted" style={{ fontSize: 10, marginTop: 0, marginBottom: 6 }}>
                Every policy choice you make in chromatika. Mirrors the on-chain events emitted
                by the Move module; capped at 200 most recent. The Sui chain's events remain
                queryable forever via Suiscan.
              </p>
              {auditEntries && auditEntries.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 240, overflowY: 'auto' }}>
                  {auditEntries
                    .slice()
                    .reverse()
                    .map((e, i) => (
                      <div
                        key={`${e.timestampMs}-${i}`}
                        style={{
                          padding: '4px 6px',
                          background: 'rgba(255,255,255,0.04)',
                          borderRadius: 3,
                          fontSize: 10,
                          fontFamily: 'monospace',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ opacity: 0.7 }}>
                            {new Date(e.timestampMs).toLocaleString()}
                          </span>
                          <strong
                            style={{
                              color: e.kind.startsWith('sign-aborted')
                                ? '#ef4444'
                                : e.kind === 'panic'
                                  ? '#ef4444'
                                  : e.kind === 'unfreeze'
                                    ? '#86efac'
                                    : 'inherit',
                            }}
                          >
                            {AUDIT_KIND_LABELS[e.kind]}
                          </strong>
                          {e.digest && (
                            <a
                              href={`https://suiscan.xyz/tx/${e.digest}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ marginLeft: 'auto', fontSize: 9, opacity: 0.7 }}
                            >
                              {e.digest.slice(0, 10)}…
                            </a>
                          )}
                        </div>
                        {(e.prev || e.next) && (
                          <div style={{ opacity: 0.7, marginTop: 1 }}>
                            {e.prev !== undefined && <>prev: {e.prev}</>}
                            {e.prev !== undefined && e.next !== undefined && ' → '}
                            {e.next !== undefined && <>next: {e.next}</>}
                          </div>
                        )}
                        {e.detail && (
                          <div style={{ opacity: 0.6, marginTop: 1, wordBreak: 'break-all' }}>{e.detail}</div>
                        )}
                      </div>
                    ))}
                </div>
              ) : (
                <div className="sp-muted" style={{ fontSize: 10 }}>no entries yet.</div>
              )}
              <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  className="sp-btn sp-btn--ghost"
                  onClick={() => void refresh()}
                  style={{ fontSize: 10, padding: '1px 6px', display: 'inline-flex', alignItems: 'center', gap: 3 }}
                >
                  <RefreshCw size={10} /> refresh
                </button>
                <button
                  type="button"
                  className="sp-btn sp-btn--ghost"
                  onClick={() =>
                    void run(
                      'clear-audit',
                      () => trpc.clearPolicyAuditEntries.mutate({ dwalletId: link.dwalletId }),
                      'audit log cleared (local only)',
                    )
                  }
                  disabled={busy !== null || (auditEntries?.length ?? 0) === 0}
                  style={{ fontSize: 10, padding: '1px 6px', display: 'inline-flex', alignItems: 'center', gap: 3, color: 'oklch(0.6 0.22 25)' }}
                >
                  <Trash2 size={10} /> clear
                </button>
              </div>
            </div>
          </details>

          {/* exit policy: two-step unwrap (the user-controlled way out / migration primitive) */}
          {snap && (
            <details style={{ marginTop: 10, padding: 6, border: '1px solid color-mix(in oklch, oklch(0.6 0.22 25) 30%, transparent)', borderRadius: 4 }}>
              <summary style={{ fontSize: 11, fontWeight: 600, cursor: 'pointer', color: 'var(--theme-banner-error-fg, oklch(0.78 0.14 25))' }}>
                <Unlock size={11} /> exit policy (unwrap dWallet cap)
              </summary>
              <div style={{ marginTop: 6 }}>
                {!snap.unwrapRequested && (
                  <>
                    <p className="sp-muted" style={{ fontSize: 10, margin: '0 0 6px 0' }}>
                      Pull your wrapped dWallet cap back out of the PolicyVault. Two-step on
                      purpose: request now, claim after the staged delay (
                      {fmtMs(snap.stageDelayMs)}). During the wait, any actuator can panic
                      this vault to block the claim. If a thief got your active key, that wait
                      is the protection.
                    </p>
                    <button
                      type="button"
                      className="sp-btn sp-btn--ghost"
                      onClick={() =>
                        void run(
                          'request-unwrap',
                          () => trpc.requestPolicyUnwrap.mutate({ dwalletId: link.dwalletId }),
                          `unwrap requested. Claim available in ~${fmtMs(snap.stageDelayMs)}.`,
                        )
                      }
                      disabled={busy !== null || snap.panicked}
                      style={{ fontSize: 10 }}
                    >
                      request unwrap
                    </button>
                    {snap.panicked && (
                      <div className="sp-muted" style={{ fontSize: 10, marginTop: 4, color: 'var(--theme-banner-warn-fg, oklch(0.78 0.18 80))' }}>
                        Cannot request unwrap while panicked. Unfreeze first (after the delay),
                        then retry.
                      </div>
                    )}
                  </>
                )}
                {snap.unwrapRequested && snap.unwrapAtMs > Date.now() && (
                  <>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--theme-banner-warn-fg, oklch(0.78 0.18 80))', marginBottom: 4 }}>
                      <TimerReset size={11} /> Unwrap pending. Claim unlocks in{' '}
                      {fmtMs(snap.unwrapAtMs - Date.now())}.
                    </div>
                    <p className="sp-muted" style={{ fontSize: 10, margin: '0 0 6px 0' }}>
                      During the wait you can still sign normally (cap + cooldown still apply).
                      Any actuator can panic to block the claim if this request was not you.
                    </p>
                    <button
                      type="button"
                      className="sp-btn sp-btn--ghost"
                      onClick={() =>
                        void run(
                          'cancel-unwrap',
                          () => trpc.cancelPolicyUnwrap.mutate({ dwalletId: link.dwalletId }),
                          'unwrap request cancelled',
                        )
                      }
                      disabled={busy !== null}
                      style={{ fontSize: 10 }}
                    >
                      cancel unwrap
                    </button>
                  </>
                )}
                {snap.unwrapRequested && snap.unwrapAtMs <= Date.now() && (
                  <>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--theme-banner-success-fg, oklch(0.78 0.16 152))', marginBottom: 4 }}>
                      <Unlock size={11} /> Unwrap ready to claim.
                    </div>
                    <p className="sp-muted" style={{ fontSize: 10, margin: '0 0 6px 0' }}>
                      Claiming consumes the on-chain PolicyVault and returns the dWallet cap +
                      any leftover IKA / SUI balance + remaining presigns to your address. The
                      dWallet becomes policy-free after this. You can re-opt in to a newer
                      audited Policy Vault version in the same step.
                    </p>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="sp-btn sp-btn--primary"
                        onClick={() =>
                          void run(
                            'claim-unwrap',
                            () => trpc.claimPolicyUnwrap.mutate({ dwalletId: link.dwalletId }),
                            'unwrap claimed. dWallet cap returned; vault consumed.',
                          )
                        }
                        disabled={busy !== null || snap.panicked}
                        style={{ fontSize: 10 }}
                      >
                        {busy === 'claim-unwrap' ? <Loader2 size={11} className="sp-spin" /> : 'claim unwrap'}
                      </button>
                      <button
                        type="button"
                        className="sp-btn sp-btn--ghost"
                        onClick={() =>
                          void run(
                            'cancel-unwrap',
                            () => trpc.cancelPolicyUnwrap.mutate({ dwalletId: link.dwalletId }),
                            'unwrap request cancelled',
                          )
                        }
                        disabled={busy !== null}
                        style={{ fontSize: 10 }}
                      >
                        cancel
                      </button>
                    </div>
                    {snap.panicked && (
                      <div className="sp-muted" style={{ fontSize: 10, marginTop: 4, color: 'var(--theme-banner-warn-fg, oklch(0.78 0.18 80))' }}>
                        Cannot claim while panicked. This is the bypass-attack gate; an attacker
                        who triggered the unwrap cannot complete it while the vault is frozen.
                      </div>
                    )}
                  </>
                )}
              </div>
            </details>
          )}

          {/* local clear (removes the local pointer; on-chain object remains) */}
          <details style={{ marginTop: 10 }}>
            <summary className="sp-muted" style={{ fontSize: 10, cursor: 'pointer' }}>
              advanced: forget local link
            </summary>
            <div className="sp-muted" style={{ fontSize: 10, marginTop: 4 }}>
              Removes the local pointer. The on-chain PolicyVault remains; chromatika can
              re-link by setting it manually. Does NOT panic or revoke.
            </div>
            <button
              type="button"
              className="sp-btn sp-btn--ghost"
              onClick={() =>
                void run(
                  'clear-link',
                  () => trpc.clearLocalPolicyVaultLink.mutate({ dwalletId: link.dwalletId }),
                  'local link cleared',
                )
              }
              disabled={busy !== null}
              style={{ fontSize: 10, marginTop: 4 }}
            >
              forget local link
            </button>
          </details>
        </div>
      )}
    </section>
  );
}

function curveLabel(n: number): string {
  // ika curve numbers: SECP256K1=0, SECP256R1=1, ED25519=2, RISTRETTO=3
  switch (n) {
    case 0:
      return 'SECP256K1';
    case 1:
      return 'SECP256R1';
    case 2:
      return 'ED25519';
    case 3:
      return 'RISTRETTO';
    default:
      return `curve#${n}`;
  }
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  /** Optional plain-English explanation of what this setting controls and how to think
   *  about the value. Renders below the input as small muted text. */
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10, color: 'var(--sp-muted, rgba(255,255,255,0.5))', marginBottom: 2 }}>{label}</div>
      {children}
      {hint && (
        <div className="sp-muted" style={{ fontSize: 10, marginTop: 3, lineHeight: 1.45, opacity: 0.7 }}>
          {hint}
        </div>
      )}
    </div>
  );
}
