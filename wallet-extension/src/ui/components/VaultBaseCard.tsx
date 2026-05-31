import { useState, useEffect } from 'react';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CircleHelp, RefreshCw } from 'lucide-react';
import { RocketSeatGauge, type VaultHealthVisual } from '@/ui/components/RocketSeatGauge';
import { ActionBtn } from '@/ui/components/ActionBtn';
import { VaultTimeCircuits } from '@/ui/components/VaultTimeCircuits';
import { ikaFromBaseUnits, suiFromMist } from '@/lib/sui-amount';
import type { Balances, Networks } from '@/ui/types';
import {
  isRocketHeadId,
  DEFAULT_PILOT_HEAD,
  DEFAULT_PASSENGER_HEAD,
  type RocketHeadId,
} from '@/ui/components/rocket-heads';
import { FEATURES } from '@/config/features';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import { feePayerExplorerHref } from '@/lib/explorer-href';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import { STORAGE_KEYS } from '@/background/storage';

const PILOT_KEY = STORAGE_KEYS.ROCKET_PILOT_HEAD_V1;
const PASSENGER_KEY = STORAGE_KEYS.ROCKET_PASSENGER_HEAD_V1;
const ANIM_KEY = STORAGE_KEYS.ANIMATIONS_V1;

function suiHealthLevel(suiMist: string): Exclude<VaultHealthVisual, 'empty'> {
  const sui = suiFromMist(suiMist || '0');
  if (sui < 0.2) return 'red';
  if (sui < 1) return 'yellow';
  return 'green';
}

function ikaHealthLevel(ikaBase: string): Exclude<VaultHealthVisual, 'empty'> {
  const ika = ikaFromBaseUnits(ikaBase || '0');
  if (ika <= 0) return 'red';
  if (ika < 1) return 'yellow';
  return 'green';
}

function gaugeFill(h: Exclude<VaultHealthVisual, 'empty'>): number {
  if (h === 'green') return 100;
  if (h === 'yellow') return 32;
  return 12;
}

/** devnet SOL thresholds for fee payer (not Sui gas) */
function solanaSolHealth(lamportsStr: string): Exclude<VaultHealthVisual, 'empty'> {
  const sol = Number(lamportsStr || '0') / 1e9;
  if (sol < 0.0001) return 'red';
  if (sol < 0.02) return 'yellow';
  return 'green';
}

export function VaultBaseCard({
  balances,
  network,
  networks,
  vaultId,
  vaultLabel,
  showHelpOverlay,
  onBalancesRefresh,
  onSwapClick,
  swapOpen,
  onSendClick,
  onReceiveClick,
  beginner = false,
}: {
  balances: Balances;
  network: string;
  networks: Networks | null;
  /** active vault id - needed by the BTTF time-circuits panel to subscribe to the snapshot. */
  vaultId: string | null;
  vaultLabel?: string;
  /** when true, the cockpit-bottom help-text overlay is rendered. gated by the
   *  `uiHelpHints` settings toggle. */
  showHelpOverlay?: boolean;
  onBalancesRefresh?: () => void;
  onSwapClick?: () => void;
  swapOpen?: boolean;
  /** when provided, the send button is enabled and routes to the wallet's Send page. */
  onSendClick?: () => void;
  /** when provided, the receive button is enabled and opens the address sheet for the vault. */
  onReceiveClick?: () => void;
  /** beginner tier: plain "Account" wording, no MPC/keyring jargon in the help overlay. */
  beginner?: boolean;
}) {
  const funded = balances.funding?.ready === true;
  const fee = balances.feePayerAddress ?? '';
  const isSolanaPreAlpha =
    balances.locked === false && 'ikaBase' in balances && balances.ikaBase === 'solana';
  const solanaLamports = isSolanaPreAlpha && 'solanaLamports' in balances ? balances.solanaLamports : '0';
  const solanaRpcMissing = isSolanaPreAlpha && 'solanaRpcMissing' in balances && balances.solanaRpcMissing;
  const solanaBalanceWarning =
    isSolanaPreAlpha &&
    'solanaBalanceWarning' in balances &&
    typeof (balances as { solanaBalanceWarning?: string }).solanaBalanceWarning === 'string'
      ? (balances as { solanaBalanceWarning: string }).solanaBalanceWarning
      : null;
  const [pilotHead, setPilotHead] = useState<RocketHeadId>(DEFAULT_PILOT_HEAD);
  const [passengerHead, setPassengerHead] = useState<RocketHeadId>(DEFAULT_PASSENGER_HEAD);
  const [animationsOn, setAnimationsOn] = useState(true);
  const explorerPrefs = useExplorerPreferences();

  useEffect(() => {
    function read() {
      chrome.storage.local.get([PILOT_KEY, PASSENGER_KEY, ANIM_KEY], (r) => {
        const p = r[PILOT_KEY];
        if (typeof p === 'string' && isRocketHeadId(p)) setPilotHead(p);
        const pa = r[PASSENGER_KEY];
        if (typeof pa === 'string' && isRocketHeadId(pa)) setPassengerHead(pa);
        setAnimationsOn(r[ANIM_KEY] !== false);
      });
    }
    read();
    const onStore = () => read();
    chrome.storage.onChanged.addListener(onStore);
    return () => chrome.storage.onChanged.removeListener(onStore);
  }, []);

  const sHealth = isSolanaPreAlpha
    ? solanaSolHealth(solanaLamports)
    : suiHealthLevel(balances.sui ?? '0');
  const iHealth = isSolanaPreAlpha
    ? ('yellow' as const)
    : ikaHealthLevel(balances.ika ?? '0');
  const suiAmt = suiFromMist(balances.sui ?? '0');
  const ikaAmt = ikaFromBaseUnits(balances.ika ?? '0');
  const solSol = Number(solanaLamports || '0') / 1e9;
  const suiLabel = isSolanaPreAlpha ? `SOL ${solSol.toFixed(4)}` : `SUI ${suiAmt.toFixed(2)}`;
  const ikaLabel = isSolanaPreAlpha ? 'ika' : `IKA ${ikaAmt.toFixed(1)}`;
  const worstHealth: Exclude<VaultHealthVisual, 'empty'> = !funded
    ? 'red'
    : sHealth === 'red' || iHealth === 'red'
      ? 'red'
      : sHealth === 'yellow' || iHealth === 'yellow'
        ? 'yellow'
        : 'green';

  const feeExplorerHref =
    fee && 'ikaBase' in balances
      ? feePayerExplorerHref(
          explorerPrefs,
          networks,
          fee,
          balances.ikaBase === 'solana' ? 'solana' : 'sui',
          network,
        )
      : null;

  const showSwap =
    !isSolanaPreAlpha && FEATURES.PHASE_B_SUI_SWAP && typeof onSwapClick === 'function';
  const vaultRailCount = 2 + (showSwap ? 1 : 0) + (onBalancesRefresh ? 1 : 0);

  return (
    <div className="cv-cockpitAndCard">
      {/* beginner tier: hide the mainnet/testnet time-circuits totals; the single balance
          lives in the header pill instead. */}
      {!beginner && <VaultTimeCircuits vaultId={vaultId} />}
      <RocketSeatGauge
        suiFillPct={funded ? gaugeFill(sHealth) : 0}
        ikaFillPct={funded ? gaugeFill(iHealth) : 0}
        suiHealth={sHealth}
        ikaHealth={iHealth}
        suiLabel={suiLabel}
        ikaLabel={ikaLabel}
        pilotHeadId={pilotHead}
        passengerHeadId={passengerHead}
        animationsOn={animationsOn}
        funded={funded}
        baseChain={isSolanaPreAlpha ? 'solana' : 'sui'}
      />

      {showHelpOverlay ? (
        <aside className="cv-cockpitHelpOverlay" role="note" aria-label="cockpit tip">
          <span className="cv-cockpitHelpOverlay-icon" aria-hidden>
            <CircleHelp size={14} strokeWidth={2} />
          </span>
          <p className="cv-cockpitHelpOverlay-text">
            {beginner ? (
              <>
                This is your <strong>account</strong>. The bars show what's available to cover network fees.
              </>
            ) : (
              <>
                Your <strong>dWallet Vault</strong> is the owner keyring that pays fees.{' '}
                {isSolanaPreAlpha ? (
                  <>
                    <strong>SOL</strong> pays solana network gas; <strong>ika</strong> pays the MPC signing network.
                  </>
                ) : (
                  <>
                    <strong>SUI</strong> pays sui network gas; <strong>IKA</strong> pays the MPC signing network.
                  </>
                )}{' '}
                Both gauges are for the active vault only.
              </>
            )}
          </p>
        </aside>
      ) : null}

      {solanaRpcMissing ? (
        <div className="sp-error" role="alert" style={{ marginTop: 8 }}>
          solana RPC not configured - balance may be stale; check session / devnet settings.
        </div>
      ) : null}
      {solanaBalanceWarning ? (
        <div className="sp-error" role="alert" style={{ marginTop: 8, lineHeight: 1.45 }}>
          {solanaBalanceWarning}
        </div>
      ) : null}
      {!funded && !isSolanaPreAlpha ? (
        <div className="cv-fundingPill" role="status">
          {beginner ? (
            <>Add <strong>SUI</strong> and <strong>IKA</strong> above before this account can be used.</>
          ) : (
            <>Add <strong>SUI</strong> (for sui gas) and <strong>IKA</strong> (for MPC signing) before this vault can run.</>
          )}
        </div>
      ) : null}

      <section className="cv-baseCard" data-vault-health={worstHealth}>
        <div className="cv-baseCard-columns" data-vault-rail-count={vaultRailCount}>
          <div className="cv-baseCard-body">
            {vaultLabel && (
              <div className="cv-baseCard-vaultName">{vaultLabel}</div>
            )}
            <div className="cv-baseCard-kicker">
              {isSolanaPreAlpha
                ? 'Solana devnet fee payer (ika pre-alpha)'
                : beginner
                  ? 'Account'
                  : 'dWallet Vault Account'}
            </div>
            <div className="cv-baseCard-addrRow">
              {fee ? (
                <ExplorerValueRow
                  fullValue={fee}
                  href={feeExplorerHref}
                  truncateMid={{ head: 10, tail: 6 }}
                  copyLabel="copy fee payer address"
                  className="cv-baseCard-addrExplorer"
                  linkClassName="cd-explorerMonoLink cv-baseCard-addr"
                />
              ) : (
                <span className="cv-baseCard-addr sp-muted">—</span>
              )}
            </div>
            {isSolanaPreAlpha ? (
              <div className="cv-baseCard-faucetNote">
                {funded ? (
                  <>
                    Need more devnet SOL?{' '}
                    <a
                      className="cv-baseCard-faucetLink"
                      href="https://faucet.solana.com/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      devnet faucet
                    </a>
                  </>
                ) : (
                  <>
                    This address needs devnet SOL to run Ika transactions —{' '}
                    <a
                      className="cv-baseCard-faucetLink"
                      href="https://faucet.solana.com/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      devnet faucet
                    </a>
                  </>
                )}
              </div>
            ) : null}
          </div>

          <aside
            className="cv-baseCard-actionsCol"
            data-swap-open={swapOpen && showSwap ? 'true' : 'false'}
            aria-label="quick actions"
          >
            <div className="cv-baseCard-actionStack">
              <ActionBtn
                icon={ArrowUpRight}
                label="send"
                onClick={onSendClick}
                disabled={!onSendClick}
                compact
              />
              <ActionBtn
                icon={ArrowDownLeft}
                label="receive"
                onClick={onReceiveClick}
                disabled={!onReceiveClick}
                compact
              />
              {showSwap ? (
                <ActionBtn icon={ArrowLeftRight} label="swap" onClick={onSwapClick} compact />
              ) : null}
              {onBalancesRefresh ? (
                <button
                  type="button"
                  className="cv-balancesRefreshBtn cv-balancesRefreshBtn--vaultRail"
                  aria-label="refresh balances"
                  title="refresh balances"
                  onClick={onBalancesRefresh}
                >
                  <RefreshCw size={18} strokeWidth={2} />
                </button>
              ) : null}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}
