import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronRight,
  Wallet,
  Palette,
  Shield,
  Globe,
  ExternalLink,
  Lock as LockIcon,
  CreditCard,
  Plug,
  HardDrive,
  HelpCircle,
  Wrench,
  EyeOff,
  Boxes,
  Bell,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import {
  ROCKET_HEAD_IDS,
  ROCKET_HEAD_LABELS,
  pilotFrontPreviewHref,
  isRocketHeadId,
  DEFAULT_PILOT_HEAD,
  DEFAULT_PASSENGER_HEAD,
  type RocketHeadId,
} from '@/ui/components/rocket-heads';
import { GraphqlPaginationDebugPanel } from '@/ui/graphql-pagination-debug-panel';
import type { MediaSafetyMode } from '@/background/services/media-safety';
import type { AppearanceMode } from '@/background/appearance-mode';
import type { Networks } from '@/ui/types';
import { BiometricUnlockSettings } from '@/ui/components/BiometricUnlockSettings';
import { AlertsSettingsSection } from '@/ui/components/AlertsSettingsSection';
import { PcTokenMarketsPanel } from '@/ui/components/PcTokenMarketsPanel';
import { DeSoPanel } from '@/ui/components/DeSoPanel';
import { X402ReceiptsSection } from '@/ui/components/X402ReceiptsSection';
import { PreviewDisabledTooltip } from '@/ui/components/PreviewDisabledTooltip';
import { AnalyticsConsentToggle } from '@/ui/components/AnalyticsConsentToggle';
import { DAppsPage } from '@/ui/pages/DAppsPage';
import { NetworkSelectorPage } from '@/ui/pages/NetworkSelectorPage';
import { NotificationSettingsPage } from '@/ui/pages/NotificationSettingsPage';
import {
  DEFAULT_EXPLORER_PREFERENCES,
  SOLANA_EXPLORER_OPTIONS,
  SUI_EXPLORER_OPTIONS,
  type ExplorerPreferences,
} from '@/config/explorers';
import {
  DEFAULT_PRICE_SOURCE_ORDER,
  PRICE_SOURCE_LABELS,
  type PriceSourceId,
} from '@/config/price-sources';
import {
  ENCRYPT_EXAMPLE_ACL_URL,
  ENCRYPT_EXAMPLE_COIN_FLIP_URL,
  ENCRYPT_EXAMPLE_VOTING_URL,
  ENCRYPT_PC_SWAP_BOOK_URL,
  ENCRYPT_PC_TOKEN_BOOK_URL,
} from '@/background/encrypt/encrypt-constants';

import { STORAGE_KEYS } from '@/background/storage';
import { useSendAmountInputMode } from '@/lib/use-send-amount-input-mode';

export type SettingsTab =
  | 'main'
  | 'appearance'
  | 'safety'
  | 'networks'
  | 'explorers'
  | 'confidential'
  | 'payments'
  | 'dapps'
  | 'hardware'
  | 'help'
  | 'advanced'
  | 'notifications';

const PILOT_KEY = STORAGE_KEYS.ROCKET_PILOT_HEAD_V1;
const PASSENGER_KEY = STORAGE_KEYS.ROCKET_PASSENGER_HEAD_V1;
const ANIM_KEY = STORAGE_KEYS.ANIMATIONS_V1;

/** subscreen header w/ back button. consistent across every settings sub-page. */
function SubScreenHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="sp-pageHeader">
      <button type="button" className="sp-backBtn" onClick={onBack}>
        ← back
      </button>
      <h2 className="sp-pageTitle" style={{ marginBottom: 0 }}>
        {title}
      </h2>
    </div>
  );
}

type MenuRowProps = {
  icon: ReactNode;
  title: string;
  desc?: string;
  badge?: string;
  onClick: () => void;
  variant?: 'default' | 'danger';
};

const SETTINGS_PREVIEW_MENU_MSG = 'settings - not available in live preview';

function gateSettingsMainMenuRow(node: ReactNode) {
  if (!__CHROMATIKA_PREVIEW_IFRAME__) return node;
  return (
    <PreviewDisabledTooltip layout="block" message={SETTINGS_PREVIEW_MENU_MSG}>
      {node}
    </PreviewDisabledTooltip>
  );
}

function MenuRow({ icon, title, desc, badge, onClick, variant = 'default' }: MenuRowProps) {
  return (
    <button
      type="button"
      className={`sp-menuRow${variant === 'danger' ? ' sp-menuRow--danger' : ''}`}
      onClick={onClick}
    >
      <span className="sp-menuRowIcon" aria-hidden>
        {icon}
      </span>
      <span className="sp-menuRowBody">
        <span className="sp-menuRowTitle">
          {title}
          {badge ? (
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                marginLeft: 8,
                padding: '1px 7px',
                borderRadius: 999,
                background: 'rgba(255, 175, 70, 0.18)',
                color: 'rgba(255, 195, 110, 0.95)',
                verticalAlign: 1,
              }}
            >
              {badge}
            </span>
          ) : null}
        </span>
        {desc ? <span className="sp-menuRowDesc">{desc}</span> : null}
      </span>
      {variant !== 'danger' && (
        <ChevronRight size={16} strokeWidth={2} className="sp-menuRowChev" />
      )}
    </button>
  );
}

export function SettingsPage({
  networks,
  advanced,
  appearance,
  setAppearance,
  onAdvancedChange,
  uiHelpHints,
  onUiHelpHintsChange,
  onRefresh,
  initialStab,
  onOpenVaultManagement,
}: {
  networks: Networks | null;
  advanced: boolean;
  appearance: AppearanceMode;
  setAppearance: (v: AppearanceMode) => void | Promise<void>;
  onAdvancedChange: (v: boolean) => void;
  uiHelpHints: boolean;
  onUiHelpHintsChange: (v: boolean) => void;
  onRefresh: () => void;
  initialStab?: SettingsTab;
  onOpenVaultManagement?: () => void;
}) {
  const [stab, setStab] = useState<SettingsTab>(initialStab ?? 'main');
  const [networkTier, setNetworkTier] = useState<'vault' | 'dwallet'>('dwallet');
  const [sendAmountMode, setSendAmountMode] = useSendAmountInputMode();
  const [safetyMode, setSafetyMode] = useState<MediaSafetyMode>('ipfs_arweave');
  const [consentMode, setConsentMode] = useState<'compat' | 'strict'>('compat');
  const [pilotHead, setPilotHead] = useState<RocketHeadId>(DEFAULT_PILOT_HEAD);
  const [passengerHead, setPassengerHead] = useState<RocketHeadId>(DEFAULT_PASSENGER_HEAD);
  const [rocketAnim, setRocketAnim] = useState(true);
  const [explorerPrefs, setExplorerPrefs] = useState<ExplorerPreferences>(DEFAULT_EXPLORER_PREFERENCES);
  const [priceOrder, setPriceOrder] = useState<PriceSourceId[]>(DEFAULT_PRICE_SOURCE_ORDER);

  useEffect(() => {
    trpc.getMediaSafetyMode.query().then(setSafetyMode).catch(() => {});
    trpc.getDappConsentMode.query().then(setConsentMode).catch(() => {});
    trpc.getExplorerPreferences.query().then(setExplorerPrefs).catch(() => {});
    trpc.getPricePreferences.query().then((p) => setPriceOrder(p.order)).catch(() => {});
    chrome.storage.local.get([PILOT_KEY, PASSENGER_KEY, ANIM_KEY], (r) => {
      const p = r[PILOT_KEY];
      if (typeof p === 'string' && isRocketHeadId(p)) setPilotHead(p);
      const pa = r[PASSENGER_KEY];
      if (typeof pa === 'string' && isRocketHeadId(pa)) setPassengerHead(pa);
      if (r[ANIM_KEY] === false) setRocketAnim(false);
    });
  }, []);

  async function onSetSafety(mode: MediaSafetyMode) {
    await trpc.setMediaSafetyMode.mutate({ mode });
    setSafetyMode(mode);
  }

  async function onToggleAdvanced() {
    const next = !advanced;
    await trpc.setAdvancedMode.mutate({ enabled: next });
    onAdvancedChange(next);
  }

  async function onToggleUiHelpHints() {
    const next = !uiHelpHints;
    await trpc.setUiHelpHints.mutate({ enabled: next });
    onUiHelpHintsChange(next);
  }

  async function onLock() {
    await trpc.lock.mutate();
    window.location.reload();
  }

  async function saveExplorerPrefs(next: ExplorerPreferences) {
    setExplorerPrefs(next);
    await trpc.setExplorerPreferences.mutate(next);
  }

  async function savePriceOrder(next: PriceSourceId[]) {
    setPriceOrder(next);
    await trpc.setPricePreferences.mutate({ order: next });
  }

  function movePriceSource(from: number, to: number) {
    if (to < 0 || to >= priceOrder.length) return;
    const next = [...priceOrder];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    void savePriceOrder(next);
  }

  // ----- subscreens ----- //
  if (stab === 'networks') {
    return (
      <NetworkSelectorPage
        tier={networkTier}
        networks={networks}
        onBack={() => {
          setStab('main');
          onRefresh();
        }}
        onRefresh={onRefresh}
      />
    );
  }

  if (stab === 'dapps') {
    return <DAppsPage onBack={() => setStab('main')} />;
  }

  const pilotFrontPreview = pilotFrontPreviewHref(pilotHead);
  const passengerFrontPreview = pilotFrontPreviewHref(passengerHead);

  if (stab === 'appearance') {
    return (
      <div className="sp-page">
        <SubScreenHeader title="appearance & cockpit" onBack={() => setStab('main')} />

        <div className="sp-section">
          <div className="sp-sectionTitle">theme</div>
          <div className="sp-chipRow">
            <button
              type="button"
              className={`sp-chip${appearance === 'dark' ? ' sp-chipActive' : ''}`}
              onClick={() => void setAppearance('dark')}
            >
              dark
            </button>
            <button
              type="button"
              className={`sp-chip${appearance === 'light' ? ' sp-chipActive' : ''}`}
              onClick={() => void setAppearance('light')}
            >
              light
            </button>
          </div>
          <div className="sp-muted" style={{ fontSize: 11, marginTop: 6 }}>
            separate from sui/solana base chain (header). more palette tuning later.
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-sectionTitle">send: amount entry</div>
          <div className="sp-chipRow">
            <button
              type="button"
              className={`sp-chip${sendAmountMode === 'number' ? ' sp-chipActive' : ''}`}
              onClick={() => setSendAmountMode('number')}
              aria-pressed={sendAmountMode === 'number'}
            >
              number + Max
            </button>
            <button
              type="button"
              className={`sp-chip${sendAmountMode === 'slider' ? ' sp-chipActive' : ''}`}
              onClick={() => setSendAmountMode('slider')}
              aria-pressed={sendAmountMode === 'slider'}
            >
              slider
            </button>
          </div>
          <div className="sp-muted" style={{ fontSize: 11, marginTop: 6 }}>
            applies to the Send tab's Confirm step. slider mode clamps at the policy-vault cap when
            one is active for the source dWallet.
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-sectionTitle">rocket cockpit</div>
          <div className="sp-muted" style={{ fontSize: 12, marginBottom: 12 }}>
            cockpit crew + motion (respects reduced motion too)
          </div>
          <label className="sp-swapLabel" style={{ marginBottom: 8 }}>
            pilot (left seat)
            <select
              className="sp-input"
              value={pilotHead}
              onChange={(e) => {
                const v = e.target.value;
                if (!isRocketHeadId(v)) return;
                setPilotHead(v);
                chrome.storage.local.set({ [PILOT_KEY]: v });
              }}
            >
              {ROCKET_HEAD_IDS.map((id) => (
                <option key={id} value={id}>
                  {ROCKET_HEAD_LABELS[id]}
                </option>
              ))}
            </select>
          </label>
          {pilotFrontPreview && (
            <div style={{ marginTop: 10, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
              <img
                src={pilotFrontPreview}
                alt=""
                width={48}
                height={48}
                style={{
                  borderRadius: 10,
                  objectFit: 'cover',
                  border: '1px solid rgba(255,255,255,0.12)',
                }}
              />
              <span className="sp-muted" style={{ fontSize: 11 }}>front preview</span>
            </div>
          )}
          <label className="sp-swapLabel" style={{ marginBottom: 8 }}>
            passenger (right seat)
            <select
              className="sp-input"
              value={passengerHead}
              onChange={(e) => {
                const v = e.target.value;
                if (!isRocketHeadId(v)) return;
                setPassengerHead(v);
                chrome.storage.local.set({ [PASSENGER_KEY]: v });
              }}
            >
              {ROCKET_HEAD_IDS.map((id) => (
                <option key={id} value={id}>
                  {ROCKET_HEAD_LABELS[id]}
                </option>
              ))}
            </select>
          </label>
          {passengerFrontPreview && (
            <div style={{ marginTop: 10, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
              <img
                src={passengerFrontPreview}
                alt=""
                width={48}
                height={48}
                style={{
                  borderRadius: 10,
                  objectFit: 'cover',
                  border: '1px solid rgba(255,255,255,0.12)',
                }}
              />
              <span className="sp-muted" style={{ fontSize: 11 }}>front preview</span>
            </div>
          )}
          <label className="sp-toggle" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={rocketAnim}
              onChange={(e) => {
                const on = e.target.checked;
                setRocketAnim(on);
                chrome.storage.local.set({ [ANIM_KEY]: on });
              }}
            />
            <span>cockpit animations</span>
          </label>
        </div>
      </div>
    );
  }

  if (stab === 'safety') {
    return (
      <div className="sp-page">
        <SubScreenHeader title="privacy & safety" onBack={() => setStab('main')} />

        <BiometricUnlockSettings />

        <AlertsSettingsSection advanced={advanced} />

        <div className="sp-section">
          <div className="sp-sectionTitle">media safety mode</div>
          <div className="sp-chipRow">
            {(['all', 'ipfs_arweave', 'none'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`sp-chip${safetyMode === m ? ' sp-chipActive' : ''}`}
                onClick={() => onSetSafety(m)}
              >
                {m === 'ipfs_arweave' ? 'ipfs/arweave' : m}
              </button>
            ))}
          </div>
          <div className="sp-muted" style={{ fontSize: 11, marginTop: 6 }}>
            {safetyMode === 'none' && 'no nft/kiosk images loaded'}
            {safetyMode === 'ipfs_arweave' && 'only ipfs + arweave images shown (default)'}
            {safetyMode === 'all' && 'all image sources - trust everything, yolo'}
          </div>
        </div>

        <DismissedPromptsSection />

        <HiddenAssetsSection />
      </div>
    );
  }

  if (stab === 'explorers') {
    return (
      <div className="sp-page">
        <SubScreenHeader title="explorers & prices" onBack={() => setStab('main')} />

        <div className="sp-section">
          <div className="sp-sectionTitle">explorers</div>
          <label className="sp-swapLabel" style={{ marginBottom: 10 }}>
            sui explorer
            <select
              className="sp-input"
              value={explorerPrefs.sui.preset}
              onChange={(e) => {
                const preset = e.target.value as ExplorerPreferences['sui']['preset'];
                void saveExplorerPrefs({
                  ...explorerPrefs,
                  sui: { ...explorerPrefs.sui, preset },
                });
              }}
            >
              {SUI_EXPLORER_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          {explorerPrefs.sui.preset === 'custom' && (
            <label className="sp-swapLabel" style={{ marginBottom: 10 }}>
              sui custom template
              <input
                className="sp-input"
                placeholder="https://example.com/{network}/{type}/{id}"
                value={explorerPrefs.sui.customTemplate ?? ''}
                onChange={(e) => {
                  const customTemplate = e.target.value;
                  void saveExplorerPrefs({
                    ...explorerPrefs,
                    sui: { ...explorerPrefs.sui, customTemplate },
                  });
                }}
              />
            </label>
          )}
          <label className="sp-swapLabel" style={{ marginBottom: 10 }}>
            solana explorer
            <select
              className="sp-input"
              value={explorerPrefs.solana.preset}
              onChange={(e) => {
                const preset = e.target.value as ExplorerPreferences['solana']['preset'];
                void saveExplorerPrefs({
                  ...explorerPrefs,
                  solana: { ...explorerPrefs.solana, preset },
                });
              }}
            >
              {SOLANA_EXPLORER_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          {explorerPrefs.solana.preset === 'custom' && (
            <label className="sp-swapLabel" style={{ marginBottom: 10 }}>
              solana custom template
              <input
                className="sp-input"
                placeholder="https://example.com/{type}/{id}?cluster={cluster}"
                value={explorerPrefs.solana.customTemplate ?? ''}
                onChange={(e) => {
                  const customTemplate = e.target.value;
                  void saveExplorerPrefs({
                    ...explorerPrefs,
                    solana: { ...explorerPrefs.solana, customTemplate },
                  });
                }}
              />
            </label>
          )}
          <div className="sp-muted" style={{ fontSize: 11, lineHeight: 1.45 }}>
            defaults: suiscan for sui, solscan for solana. custom templates can use <code>{'{network}'}</code>,{' '}
            <code>{'{cluster}'}</code>, <code>{'{type}'}</code>, and <code>{'{id}'}</code>.
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-sectionTitle">USD price sources</div>
          <div className="sp-muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.45 }}>
            try order for portfolio + send screens. CoinMarketCap only runs when <code>VITE_CMC_API_KEY</code> is set at
            build time. Switchboard is not implemented and does not appear here on purpose.
          </div>
          <ol style={{ paddingLeft: 18, margin: 0 }}>
            {priceOrder.map((id, idx) => (
              <li key={id} style={{ marginBottom: 8, fontSize: 13 }}>
                <span style={{ marginRight: 8 }}>{PRICE_SOURCE_LABELS[id]}</span>
                <button
                  type="button"
                  className="sp-btn"
                  style={{ marginRight: 4, padding: '2px 8px', fontSize: 11 }}
                  disabled={idx === 0}
                  onClick={() => movePriceSource(idx, idx - 1)}
                >
                  up
                </button>
                <button
                  type="button"
                  className="sp-btn"
                  style={{ padding: '2px 8px', fontSize: 11 }}
                  disabled={idx === priceOrder.length - 1}
                  onClick={() => movePriceSource(idx, idx + 1)}
                >
                  down
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="sp-btn"
            style={{ marginTop: 8 }}
            onClick={() => void savePriceOrder([...DEFAULT_PRICE_SOURCE_ORDER])}
          >
            reset default order
          </button>
        </div>
      </div>
    );
  }

  if (stab === 'confidential') {
    return (
      <div className="sp-page">
        <SubScreenHeader title="confidential compute" onBack={() => setStab('main')} />

        <PcTokenMarketsPanel advanced={advanced} />

        <DeSoPanel advanced={advanced} />

        {advanced && (
          <div className="sp-section">
            <div className="sp-sectionTitle">Encrypt.xyz example books</div>
            <p className="sp-muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.45 }}>
              Solana pre-alpha program + gRPC only. not production privacy; see repo `docs/SOLANA_IKA_LIMITS.md` and
              `docs/ENCRYPT_SUI_ISOLATION.md`. handy when you are building against Encrypt devnet.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <a
                href={ENCRYPT_EXAMPLE_COIN_FLIP_URL}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12, color: 'rgba(165,180,252,0.95)', textDecoration: 'underline' }}
              >
                encrypted coin flip
              </a>
              <a
                href={ENCRYPT_EXAMPLE_VOTING_URL}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12, color: 'rgba(165,180,252,0.95)', textDecoration: 'underline' }}
              >
                confidential voting
              </a>
              <a
                href={ENCRYPT_EXAMPLE_ACL_URL}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12, color: 'rgba(165,180,252,0.95)', textDecoration: 'underline' }}
              >
                encrypted ACL
              </a>
              <a
                href={ENCRYPT_PC_TOKEN_BOOK_URL}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12, color: 'rgba(165,180,252,0.95)', textDecoration: 'underline' }}
              >
                PC-Token overview
              </a>
              <a
                href={ENCRYPT_PC_SWAP_BOOK_URL}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12, color: 'rgba(165,180,252,0.95)', textDecoration: 'underline' }}
              >
                PC-Swap overview
              </a>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (stab === 'payments') {
    return (
      <div className="sp-page">
        <SubScreenHeader title="payments (x402)" onBack={() => setStab('main')} />
        <X402ReceiptsSection />
      </div>
    );
  }

  if (stab === 'hardware') {
    return (
      <div className="sp-page">
        <SubScreenHeader title="hardware wallets" onBack={() => setStab('main')} />
        <div className="sp-section">
          <div className="sp-sectionTitle">connect a device</div>
          <div className="sp-muted" style={{ fontSize: 12, lineHeight: 1.45, marginBottom: 8 }}>
            use the popup (top-right icon) to connect your Ledger - WebHID requires a user gesture there.
            Seeker (mobile MWA) connects from onboarding or vault management.
          </div>
          <div className="sp-muted" style={{ fontSize: 11, lineHeight: 1.45 }}>
            chromatika never asks for seed phrases or private keys when you choose hardware - signing happens on the
            device. trezor support not yet shipped.
          </div>
        </div>
      </div>
    );
  }

  if (stab === 'help') {
    return (
      <div className="sp-page">
        <SubScreenHeader title="help & hints" onBack={() => setStab('main')} />
        <div className="sp-section">
          <div className="sp-sectionTitle">screen help bubbles</div>
          <p className="sp-muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.45 }}>
            tips and short explainers on wallet tabs (for example the vault home intro bubble). turn off if you want a
            cleaner layout.
          </p>
          <label className="sp-toggle">
            <input type="checkbox" checked={uiHelpHints} onChange={() => void onToggleUiHelpHints()} />
            <span>{uiHelpHints ? 'on - show help bubbles where available' : 'off'}</span>
          </label>
        </div>
      </div>
    );
  }

  if (stab === 'advanced') {
    return (
      <div className="sp-page">
        <SubScreenHeader title="advanced" onBack={() => setStab('main')} />

        <div className="sp-section">
          <div className="sp-sectionTitle">advanced mode</div>
          <p className="sp-muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.45 }}>
            shows raw addresses, dev details, and additional debug panels across the app.
          </p>
          <label className="sp-toggle">
            <input type="checkbox" checked={advanced} onChange={onToggleAdvanced} />
            <span>{advanced ? 'on - raw addresses + dev details visible' : 'off'}</span>
          </label>
        </div>

        <div className="sp-section">
          <div className="sp-sectionTitle">dapp consent mode</div>
          <p className="sp-muted" style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.45 }}>
            controls how non-evm dapps prompt for connection.
          </p>
          <div className="sp-chipRow">
            <button
              type="button"
              className={`sp-chip${consentMode === 'compat' ? ' sp-chipActive' : ''}`}
              onClick={async () => {
                await trpc.setDappConsentMode.mutate({ mode: 'compat' });
                setConsentMode('compat');
              }}
            >
              compat
            </button>
            <button
              type="button"
              className={`sp-chip${consentMode === 'strict' ? ' sp-chipActive' : ''}`}
              onClick={async () => {
                await trpc.setDappConsentMode.mutate({ mode: 'strict' });
                setConsentMode('strict');
              }}
            >
              strict
            </button>
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-sectionTitle">error reporting</div>
          <AnalyticsConsentToggle />
        </div>

        {advanced && (
          <div className="sp-section" style={{ opacity: 0.72 }}>
            <div className="sp-sectionTitle">nested dWallets - chain parent sync</div>
            <p className="sp-muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.45 }}>
              ika does not yet expose a stable on-chain parent field we can import. when it does, we will pull suggested edges and
              merge with local relations (see `docs/future/NESTED_DWALLET_TREE_NOTES.md`).
            </p>
            <button type="button" className="sp-btn sp-btnFull" disabled>
              sync parents from chain (coming soon)
            </button>
          </div>
        )}

        {advanced && <GraphqlPaginationDebugPanel />}
      </div>
    );
  }

  if (stab === 'notifications') {
    return <NotificationSettingsPage onBack={() => setStab('main')} />;
  }

  // ----- main menu landing ----- //
  const dwalletEvmName =
    networks?.evm.find(
      (n) => n.chainId === (networks?.dwalletTier?.evmChainId ?? networks?.active.evmChainId),
    )?.name ?? '…';
  const safetyLabel =
    safetyMode === 'ipfs_arweave' ? 'ipfs/arweave only' : safetyMode === 'all' ? 'all sources' : 'no images';
  const themeLabel = appearance === 'dark' ? 'dark theme' : 'light theme';

  return (
    <div className="sp-page">
      <h2 className="sp-pageTitle">settings</h2>

      <div className="sp-menuList">
        <div className="sp-menuGroupLabel">wallet</div>

        {onOpenVaultManagement &&
          gateSettingsMainMenuRow(
            <MenuRow
              icon={<Wallet size={16} strokeWidth={2} />}
              title="dWallet vaults"
              desc="manage vaults, scan for more accounts, rename or remove"
              onClick={onOpenVaultManagement}
            />,
          )}

        <div className="sp-menuGroupLabel">appearance</div>

        {gateSettingsMainMenuRow(
          <MenuRow
            icon={<Palette size={16} strokeWidth={2} />}
            title="appearance & cockpit"
            desc={`${themeLabel} · pilot crew + animations`}
            onClick={() => setStab('appearance')}
          />,
        )}

        <div className="sp-menuGroupLabel">privacy</div>

        {gateSettingsMainMenuRow(
          <MenuRow
            icon={<Shield size={16} strokeWidth={2} />}
            title="privacy & safety"
            desc={`alerts · biometric unlock · media: ${safetyLabel}`}
            onClick={() => setStab('safety')}
          />,
        )}

        {gateSettingsMainMenuRow(
          <MenuRow
            icon={<Bell size={16} strokeWidth={2} />}
            title="notifications"
            desc="incoming tx, price alerts, confirmations"
            onClick={() => setStab('notifications')}
          />,
        )}

        <div className="sp-menuGroupLabel">network</div>

        {gateSettingsMainMenuRow(
          <MenuRow
            icon={<Globe size={16} strokeWidth={2} />}
            title="dWallet network"
            desc={`signing + dapps · evm: ${dwalletEvmName}`}
            onClick={() => {
              setNetworkTier('dwallet');
              setStab('networks');
            }}
          />,
        )}

        {gateSettingsMainMenuRow(
          <MenuRow
            icon={<Boxes size={16} strokeWidth={2} />}
            title="vault network"
            desc="fee payer / owner chains for the active vault"
            onClick={() => {
              setNetworkTier('vault');
              setStab('networks');
            }}
          />,
        )}

        {gateSettingsMainMenuRow(
          <MenuRow
            icon={<ExternalLink size={16} strokeWidth={2} />}
            title="explorers & prices"
            desc="block explorer choice + USD price source order"
            onClick={() => setStab('explorers')}
          />,
        )}

        <div className="sp-menuGroupLabel">apps & payments</div>

        {gateSettingsMainMenuRow(
          <MenuRow
            icon={<Plug size={16} strokeWidth={2} />}
            title="connected dapps"
            desc="review or revoke sites linked to chromatika"
            onClick={() => setStab('dapps')}
          />,
        )}

        {gateSettingsMainMenuRow(
          <MenuRow
            icon={<CreditCard size={16} strokeWidth={2} />}
            title="payments (x402)"
            desc="caps, receipts, and 402 payment history"
            onClick={() => setStab('payments')}
          />,
        )}

        {gateSettingsMainMenuRow(
          <MenuRow
            icon={<EyeOff size={16} strokeWidth={2} />}
            title="confidential compute"
            desc="PC-Token markets and DeSo private feeds"
            onClick={() => setStab('confidential')}
          />,
        )}

        <div className="sp-menuGroupLabel">more</div>

        {gateSettingsMainMenuRow(
          <MenuRow
            icon={<HardDrive size={16} strokeWidth={2} />}
            title="hardware wallets"
            desc="how to connect Ledger / Seeker"
            onClick={() => setStab('hardware')}
          />,
        )}

        {gateSettingsMainMenuRow(
          <MenuRow
            icon={<HelpCircle size={16} strokeWidth={2} />}
            title="help & hints"
            desc={`screen help bubbles: ${uiHelpHints ? 'on' : 'off'}`}
            onClick={() => setStab('help')}
          />,
        )}

        {gateSettingsMainMenuRow(
          <MenuRow
            icon={<Wrench size={16} strokeWidth={2} />}
            title="advanced"
            desc={`raw addresses + dev tools: ${advanced ? 'on' : 'off'}`}
            onClick={() => setStab('advanced')}
          />,
        )}

        <div style={{ marginTop: 14 }}>
          {gateSettingsMainMenuRow(
            <MenuRow
              icon={<LockIcon size={16} strokeWidth={2} />}
              title="lock wallet"
              desc="sign out of this session and require password to unlock"
              onClick={onLock}
              variant="danger"
            />,
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * "Prompts I've dismissed" subsection of the Safety tab. Reads + toggles the two
 * global "don't ask again" flags (`POLICY_VAULT_PROMPT_GLOBALLY_DISMISSED_V1` +
 * `DWALLET_CREATE_PROMPT_GLOBALLY_DISMISSED_V1`). Per-vault dismissal of
 * `CreateDwalletPrompt` is intentionally not exposed here; it auto-clears when the
 * vault gains a dWallet and is reset by `removeVault`.
 */
function DismissedPromptsSection() {
  const [policyVaultDismissed, setPolicyVaultDismissed] = useState<boolean | null>(null);
  const [createDwalletDismissed, setCreateDwalletDismissed] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [pv, cd] = await Promise.all([
          trpc.getPolicyVaultPromptState.query(),
          trpc.getDWalletCreatePromptState.query(),
        ]);
        if (cancelled) return;
        setPolicyVaultDismissed(pv.globallyDismissed);
        // We expose the GLOBAL flag here, not the OR'd "dismissed". A per-vault
        // dismissal is local to that vault and not the user's intent for this control.
        setCreateDwalletDismissed(cd.global ?? false);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function togglePolicyVault(next: boolean) {
    setPolicyVaultDismissed(next);
    try {
      await trpc.setPolicyVaultPromptGloballyDismissed.mutate({ dismissed: next });
    } catch (e) {
      setPolicyVaultDismissed(!next);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleCreateDwallet(next: boolean) {
    setCreateDwalletDismissed(next);
    try {
      await trpc.setDwalletCreatePromptGloballyDismissed.mutate({ dismissed: next });
    } catch (e) {
      setCreateDwalletDismissed(!next);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="sp-section">
      <div className="sp-sectionTitle">prompts I've dismissed</div>
      <p className="sp-muted" style={{ fontSize: 11, lineHeight: 1.45, margin: '0 0 8px 0' }}>
        toggling a row off restores the prompt on the next eligible event. per-vault
        dismissals (set on a specific vault) aren't shown here.
      </p>

      <PromptToggleRow
        label="post-creation Policy Vault wrap prompt"
        desc="surfaces after a new SECP256K1 dWallet is created on a Sui-base vault"
        checked={policyVaultDismissed}
        onChange={togglePolicyVault}
      />
      <PromptToggleRow
        label='"Create your first dWallets" prompt'
        desc="surfaces on the home screen when a funded vault has zero dWallets"
        checked={createDwalletDismissed}
        onChange={toggleCreateDwallet}
      />

      {err && (
        <div className="sp-error" style={{ marginTop: 6, fontSize: 11 }}>
          {err}
        </div>
      )}
    </div>
  );
}

function HiddenAssetsSection() {
  const [hiddenKeys, setHiddenKeys] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    trpc.getHiddenAssets
      .query()
      .then((r) => {
        if (!cancelled) setHiddenKeys(r.keys);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function unhide(key: string) {
    const prev = hiddenKeys;
    setHiddenKeys((ks) => ks.filter((k) => k !== key));
    try {
      await trpc.unhideAsset.mutate({ key });
    } catch (e) {
      setHiddenKeys(prev);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  if (hiddenKeys.length === 0 && !err) return null;

  return (
    <div className="sp-section">
      <div className="sp-sectionTitle">hidden portfolio tokens</div>
      <p className="sp-muted" style={{ fontSize: 11, lineHeight: 1.45, margin: '0 0 8px 0' }}>
        tokens you hid from the portfolio table. unhide to restore them.
      </p>
      {hiddenKeys.map((key) => (
        <div
          key={key}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '5px 0',
            fontSize: 12,
          }}
        >
          <span className="mono" style={{ fontSize: 11, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {key}
          </span>
          <button
            type="button"
            className="sp-btn"
            style={{ flexShrink: 0, fontSize: 11, padding: '3px 10px' }}
            onClick={() => void unhide(key)}
          >
            unhide
          </button>
        </div>
      ))}
      {err && (
        <div className="sp-error" style={{ marginTop: 6, fontSize: 11 }}>
          {err}
        </div>
      )}
    </div>
  );
}

function PromptToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean | null;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '6px 0',
        cursor: checked === null ? 'wait' : 'pointer',
        opacity: checked === null ? 0.5 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked === true}
        disabled={checked === null}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2, flexShrink: 0 }}
      />
      <span style={{ flex: 1, fontSize: 12 }}>
        <span>{label}</span>
        <span className="sp-muted" style={{ display: 'block', fontSize: 10, marginTop: 2, lineHeight: 1.45 }}>
          {desc}
        </span>
        <span className="sp-muted" style={{ display: 'block', fontSize: 10, marginTop: 4, opacity: 0.6 }}>
          {checked === true ? 'dismissed (prompt suppressed)' : 'will show on next eligible event'}
        </span>
      </span>
    </label>
  );
}
