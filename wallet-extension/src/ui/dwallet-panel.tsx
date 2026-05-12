import { useEffect, useState, type CSSProperties } from 'react';
import { trpc } from '@/lib/trpc';
import { useIkaBaseMode } from '@/lib/use-ika-base-mode';
import { useSharedBus } from '@/lib/use-shared-bus';
import { buildSolanaExplorerUrl, buildSuiExplorerUrl, type ExplorerPreferences } from '@/config/explorers';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import {
  aptosAccountExplorerUrl,
  btcAddressExplorerUrl,
  capObjectExplorerHref,
  dwalletObjectExplorerHref,
  evmAddressExplorerUrl,
} from '@/lib/explorer-href';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import type { Networks } from '@/ui/types';

type Curve = 'SECP256K1' | 'ED25519';

function LabeledExplorerAddr({
  label,
  fullValue,
  href,
  copyLabel,
}: {
  label: string;
  fullValue: string;
  href: string | null;
  copyLabel: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--faint)', flexShrink: 0, fontSize: 10 }}>{label}</span>
      <ExplorerValueRow
        fullValue={fullValue}
        href={href}
        copyLabel={copyLabel}
        linkClassName="cd-explorerMonoLink"
        className="dw-panel-addrExplorer"
      />
    </div>
  );
}

function hrefForRailAddress(
  prefs: ExplorerPreferences,
  networks: Networks | null,
  rail: 'evm' | 'btc' | 'sui' | 'solana' | 'aptos',
  address: string,
): string | null {
  if (!networks || !address.trim()) return null;
  switch (rail) {
    case 'evm': {
      const net = networks.evm.find((n) => n.chainId === networks.active.evmChainId);
      return evmAddressExplorerUrl(net?.explorerUrl, address);
    }
    case 'btc':
      return btcAddressExplorerUrl(networks, address);
    case 'sui':
      return buildSuiExplorerUrl(prefs, networks.active.suiNetworkId, 'address', address);
    case 'solana':
      return buildSolanaExplorerUrl(prefs, networks.active.solNetworkId, 'address', address);
    case 'aptos':
      return aptosAccountExplorerUrl(networks, address);
    default:
      return null;
  }
}
type OwnedCapRow = Awaited<ReturnType<typeof trpc.listOwnedDWalletCaps.query>>[number];
type DwalletAddressBook = Awaited<ReturnType<typeof trpc.dwalletAddressBook.query>>;
const BUILD_STAMP = __CHROMATIKA_BUILD_STAMP__;

export function DWalletPanel({
  enabled,
  onDwalletCreated,
}: {
  enabled: boolean;
  /** Called after a successful `createDWallet` mutation. Parent can hook this to surface
   *  the post-creation Policy Vault prompt via the `usePostCreatePolicyPrompt` hook. */
  onDwalletCreated?: (curve: 'SECP256K1' | 'ED25519') => void;
}) {
  const { broadcast } = useSharedBus();
  const { mode: ikaBaseMode } = useIkaBaseMode();
  const explorerPrefs = useExplorerPreferences();
  const [networks, setNetworks] = useState<Networks | null>(null);
  const [curve, setCurve] = useState<Curve>('SECP256K1');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [phaseB, setPhaseB] = useState<Awaited<ReturnType<typeof trpc.phaseBFundingSpike.query>> | null>(null);

  const [recipient, setRecipient] = useState('');
  const [lastDigest, setLastDigest] = useState<string | null>(null);
  const [senderKeyAddr, setSenderKeyAddr] = useState<string | null>(null);

  const [recvDwalletId, setRecvDwalletId] = useState('');
  const [recvSenderAddr, setRecvSenderAddr] = useState('');
  const [recvSourceShare, setRecvSourceShare] = useState('');
  const [recvDestShare, setRecvDestShare] = useState('');
  const [parseDigest, setParseDigest] = useState('');
  const [parseHints, setParseHints] = useState<string | null>(null);
  const [ownedCaps, setOwnedCaps] = useState<OwnedCapRow[]>([]);
  const [addressBook, setAddressBook] = useState<DwalletAddressBook | null>(null);
  const [capsBusy, setCapsBusy] = useState(false);
  const [capsError, setCapsError] = useState<string | null>(null);
  const showTransferDwallet = false;

  const sectionClass = 'sp-section';
  const btnPrimary = 'sp-btn sp-btnPrimary';
  const btn = 'sp-btn';
  const inputClass = 'sp-input';
  /** optional shared input styles; merge with flex for full-width rows */
  const inputStyle: CSSProperties | undefined = undefined;

  useEffect(() => {
    trpc.phaseBFundingSpike.query().then(setPhaseB).catch(() => setPhaseB(null));
  }, []);

  useEffect(() => {
    trpc.getNetworks.query().then(setNetworks).catch(() => setNetworks(null));
  }, []);

  async function refreshOwnedCaps() {
    setCapsBusy(true);
    setCapsError(null);
    try {
      const [rows, addrBook] = await Promise.all([
        trpc.listOwnedDWalletCaps.query(),
        trpc.dwalletAddressBook.query(),
      ]);
      setOwnedCaps(rows);
      setAddressBook(addrBook);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setCapsError(raw);
      setOwnedCaps([]);
      setAddressBook(null);
    } finally {
      setCapsBusy(false);
    }
  }

  useEffect(() => {
    refreshOwnedCaps().catch(() => setOwnedCaps([]));
  }, []);

  async function run(
    op: 'dkg' | 'complete',
    completeOpts?: { dwalletId: string; curve: Curve },
  ) {
    setBusy(true);
    setMsg(null);
    try {
      if (op === 'dkg') {
        const r = await trpc.createDWallet.mutate({ curve });
        setMsg(`dkg: ${r.phase}${r.dwalletId ? ` id ${r.dwalletId.slice(0, 10)}…` : ''}`);
        await refreshOwnedCaps();
        onDwalletCreated?.(curve);
      } else {
        const curveForComplete = completeOpts?.curve ?? curve;
        const r = await trpc.completeDWalletZeroTrust.mutate({
          curve: curveForComplete,
          ...(completeOpts?.dwalletId ? { dwalletId: completeOpts.dwalletId } : {}),
        });
        setMsg(`complete: ${r.phase}`);
        await refreshOwnedCaps();
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      if (/wallet locked/i.test(raw)) {
        broadcast({ type: 'balances_updated' });
        setMsg(
          `${raw}. session may have reset: open the wallet and retry.`,
        );
      } else {
        setMsg(raw);
      }
    } finally {
      setBusy(false);
    }
  }

  async function copySenderAddress() {
    setMsg(null);
    try {
      const addr = await trpc.getSenderEncryptionKeyAddress.query();
      setSenderKeyAddr(addr);
      await navigator.clipboard.writeText(addr);
      setMsg('copied your encryption key address (share this with recipient over a trusted channel)');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function doTransfer() {
    setBusy(true);
    setMsg(null);
    setLastDigest(null);
    try {
      const r = await trpc.transferDWallet.mutate({
        curve,
        recipientSuiAddress: recipient.trim(),
      });
      setLastDigest(r.txDigest);
      setMsg(`transfer tx submitted. digest: ${r.txDigest.slice(0, 16)}… — send digest + your encryption key address + source share id to recipient (trusted channel).`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doParseDigest() {
    setBusy(true);
    setParseHints(null);
    setMsg(null);
    try {
      const r = await trpc.parseTransferTxDigest.query({ digest: parseDigest.trim() });
      setParseHints(
        r.candidateEncryptedShareIds.length
          ? r.candidateEncryptedShareIds.join('\n')
          : '(no encrypted-share hints in events — ask sender for dest share object id)',
      );
    } catch (e) {
      setParseHints(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doAcceptTransfer() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await trpc.acceptTransferredDWallet.mutate({
        curve,
        dwalletId: recvDwalletId.trim(),
        senderEncryptionKeyAddress: recvSenderAddr.trim(),
        sourceEncryptedShareId: recvSourceShare.trim(),
        destEncryptedShareId: recvDestShare.trim(),
      });
      setMsg(`accepted transfer — dWallet phase: ${r.phase}`);
      await refreshOwnedCaps();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={sectionClass} style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, marginBottom: 8, fontWeight: 800 }}>dWallet (ika)</div>
      {ikaBaseMode === 'solana' && (
        <p
          style={{
            fontSize: 12,
            lineHeight: 1.45,
            margin: '0 0 12px',
            padding: '10px 12px',
            borderRadius: 12,
            background: 'color-mix(in oklch, var(--accent-2, oklch(0.72 0.18 290)) 22%, transparent)',
            border: '1px solid rgba(129, 140, 248, 0.35)',
            color: 'var(--text)',
          }}
        >
          ika Solana pre-alpha: DKG finishes in one gRPC step - skip the complete zero-trust buttons below (that second tx
          is Sui-only). Devnet gRPC for DKG / sign; see wallet-extension/docs/SOLANA_IKA_LIMITS.md.
        </p>
      )}
      <select
        value={curve}
        onChange={(e) => setCurve(e.target.value as Curve)}
        disabled={!enabled || busy}
        style={{ marginBottom: 10 }}
      >
        <option value="SECP256K1">SECP256K1 (evm)</option>
        <option value="ED25519">ED25519 (sui/eddsa)</option>
      </select>
      <div>
        <button type="button" className={btnPrimary} disabled={!enabled || busy} onClick={() => run('dkg')}>
          create dWallet / DKG
        </button>
        <button
          type="button"
          className={btn}
          disabled={!enabled || busy || ikaBaseMode === 'solana'}
          style={{ marginLeft: 10 }}
          title={
            ikaBaseMode === 'solana'
              ? 'Not used on Sol ika pre-alpha (no Sui second tx)'
              : 'Sui-base iki DKG only'
          }
          onClick={() => run('complete')}
        >
          complete zero-trust (auto-pick pending)
        </button>
      </div>
      {busy && (
        <p
          style={{
            fontSize: 12,
            color: 'var(--theme-banner-success-fg, oklch(0.78 0.16 152))',
            marginTop: 10,
            lineHeight: 1.45,
          }}
        >
          working… ika dWallet steps can take 30–90s. keep this window open.
        </p>
      )}
      {msg && (
        <p style={{ fontSize: 12, color: 'var(--text)', marginTop: busy ? 6 : 10, lineHeight: 1.4 }}>{msg}</p>
      )}
      <div style={{ marginTop: 12, padding: 10, borderRadius: 10, background: 'color-mix(in oklch, var(--surface, oklch(0.22 0.045 285)) 45%, transparent)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text)' }}>owned dWalletCaps (active vault)</div>
          <button type="button" className={btn} disabled={!enabled || busy || capsBusy} onClick={refreshOwnedCaps}>
            {capsBusy ? 'refreshing…' : 'refresh'}
          </button>
        </div>
        {!ownedCaps.length && (
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
            no dWalletCaps found for this vault address yet.
          </p>
        )}
        {capsError && (
          <p style={{ fontSize: 11, color: 'var(--theme-banner-warn-fg, oklch(0.78 0.18 80))', marginTop: 8, marginBottom: 0, wordBreak: 'break-word' }}>
            cap refresh error: {capsError}
          </p>
        )}
        {ownedCaps.map((row) => (
          <div
            key={row.capObjectId}
            style={{
              marginTop: 8,
              padding: '8px 10px',
              borderRadius: 8,
              background: 'color-mix(in oklch, var(--ink, oklch(0.18 0.04 280)) 55%, transparent)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text)', marginBottom: 4 }}>
              {row.needsZeroTrustCompletion ? 'needs zero-trust completion' : 'zero-trust complete or not required'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--muted)', wordBreak: 'break-all' }}>
              curve: {row.curve} - status: {row.status}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
              <span style={{ fontSize: 10, color: 'var(--faint)' }}>cap</span>
              <ExplorerValueRow
                fullValue={row.capObjectId}
                href={capObjectExplorerHref(explorerPrefs, networks, row.capObjectId)}
                truncateMid={{ head: 12, tail: 10 }}
                copyLabel="copy dWallet cap id"
                linkClassName="cd-explorerMonoLink"
              />
            </div>
            {row.capObjectId.startsWith('solana:') ? (
              <div style={{ marginTop: 4 }}>
                <div style={{ fontSize: 10, color: 'var(--faint)', marginBottom: 4 }}>
                  dWallet program account (Solana PDA)
                </div>
                <ExplorerValueRow
                  fullValue={row.dwalletId}
                  href={dwalletObjectExplorerHref(explorerPrefs, networks, row.dwalletId)}
                  truncateMid={{ head: 12, tail: 8 }}
                  copyLabel="copy dWallet object id"
                  linkClassName="cd-explorerMonoLink"
                />
                <div
                  style={{
                    fontSize: 9,
                    color: 'var(--faint)',
                    marginTop: 4,
                    lineHeight: 1.4,
                    wordBreak: 'break-word',
                  }}
                >
                  not user-facing sui/sol/apt receive lines — those come only from decoded on-chain public key material
                  below when available.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                <span style={{ fontSize: 10, color: 'var(--faint)' }}>dwallet</span>
                <ExplorerValueRow
                  fullValue={row.dwalletId}
                  href={dwalletObjectExplorerHref(explorerPrefs, networks, row.dwalletId)}
                  truncateMid={{ head: 12, tail: 10 }}
                  copyLabel="copy dWallet object id"
                  linkClassName="cd-explorerMonoLink"
                />
              </div>
            )}
            {row.needsZeroTrustCompletion && row.curve !== 'unknown' ? (
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={!enabled || busy || ikaBaseMode === 'solana'}
                  title={
                    ikaBaseMode === 'solana'
                      ? 'Sol ika pre-alpha has no Sui zero-trust completion step'
                      : undefined
                  }
                  onClick={() =>
                    run('complete', { dwalletId: row.dwalletId, curve: row.curve as Curve })
                  }
                >
                  complete zero-trust for this dWallet
                </button>
              </div>
            ) : null}
            {row.curve === 'SECP256K1' ? (
              <div style={{ marginTop: 6, fontSize: 10, color: 'var(--muted)', wordBreak: 'break-all' }}>
                <div style={{ color: 'var(--faint)', marginBottom: 4 }}>this cap (on-chain Active output)</div>
                {row.chainAddresses ? (
                  <>
                    {row.chainAddresses.evm ? (
                      <LabeledExplorerAddr
                        label="evm"
                        fullValue={row.chainAddresses.evm}
                        href={hrefForRailAddress(explorerPrefs, networks, 'evm', row.chainAddresses.evm)}
                        copyLabel="copy evm address"
                      />
                    ) : null}
                    {row.chainAddresses.btcP2wpkh ? (
                      <LabeledExplorerAddr
                        label="btc p2wpkh"
                        fullValue={row.chainAddresses.btcP2wpkh}
                        href={hrefForRailAddress(explorerPrefs, networks, 'btc', row.chainAddresses.btcP2wpkh)}
                        copyLabel="copy btc segwit address"
                      />
                    ) : null}
                    {row.chainAddresses.btcP2tr ? (
                      <LabeledExplorerAddr
                        label="btc p2tr"
                        fullValue={row.chainAddresses.btcP2tr}
                        href={hrefForRailAddress(explorerPrefs, networks, 'btc', row.chainAddresses.btcP2tr)}
                        copyLabel="copy btc taproot address"
                      />
                    ) : null}
                  </>
                ) : (
                  <div style={{ color: 'var(--faint)' }}>
                    {row.status === 'Active'
                      ? row.capObjectId.startsWith('solana:')
                        ? 'rail addresses not decoded from account data yet (RPC or layout). we do not substitute the PDA for a rail address.'
                        : 'could not derive display addresses (Solana RPC or key bytes). try refresh; signing may still work.'
                      : 'no addresses until this dWallet is Active (zero-trust complete).'}
                  </div>
                )}
              </div>
            ) : row.curve === 'ED25519' ? (
              <div style={{ marginTop: 6, fontSize: 10, color: 'var(--muted)', wordBreak: 'break-all' }}>
                <div style={{ color: 'var(--faint)', marginBottom: 4 }}>this cap (on-chain Active output)</div>
                {row.chainAddresses ? (
                  <>
                    {row.chainAddresses.sui ? (
                      <LabeledExplorerAddr
                        label="sui"
                        fullValue={row.chainAddresses.sui}
                        href={hrefForRailAddress(explorerPrefs, networks, 'sui', row.chainAddresses.sui)}
                        copyLabel="copy sui address"
                      />
                    ) : null}
                    {row.chainAddresses.solana ? (
                      <LabeledExplorerAddr
                        label="solana"
                        fullValue={row.chainAddresses.solana}
                        href={hrefForRailAddress(explorerPrefs, networks, 'solana', row.chainAddresses.solana)}
                        copyLabel="copy solana address"
                      />
                    ) : null}
                    {row.chainAddresses.aptos ? (
                      <LabeledExplorerAddr
                        label="aptos"
                        fullValue={row.chainAddresses.aptos}
                        href={hrefForRailAddress(explorerPrefs, networks, 'aptos', row.chainAddresses.aptos)}
                        copyLabel="copy aptos address"
                      />
                    ) : null}
                  </>
                ) : (
                  <div style={{ color: 'var(--faint)' }}>
                    {row.status === 'Active'
                      ? row.capObjectId.startsWith('solana:')
                        ? 'rail addresses not decoded from account data yet (RPC or layout). we do not substitute the PDA for a rail address.'
                        : 'could not derive display addresses (Solana RPC or key bytes). try refresh; signing may still work.'
                      : 'no addresses until this dWallet is Active (zero-trust complete).'}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {addressBook && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: 'color-mix(in oklch, var(--surface, oklch(0.22 0.045 285)) 45%, transparent)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>
            curve address book (meta-selected dWallet for signing)
          </div>
          <p style={{ fontSize: 10, color: 'var(--faint)', margin: '0 0 8px', lineHeight: 1.4 }}>
            multiple caps on the same curve show per-cap addresses above. this block follows vault meta (which dWallet
            the wallet uses for dapps / sends).
          </p>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>
            <div style={{ marginBottom: 6 }}>
              <div>SECP256K1 - status: {addressBook.SECP256K1.status ?? 'not created'}</div>
              <div>supports: {addressBook.SECP256K1.supports.join(', ')}</div>
              {addressBook.SECP256K1.addresses.evm ? (
                <LabeledExplorerAddr
                  label="evm"
                  fullValue={addressBook.SECP256K1.addresses.evm}
                  href={hrefForRailAddress(explorerPrefs, networks, 'evm', addressBook.SECP256K1.addresses.evm)}
                  copyLabel="copy evm address"
                />
              ) : null}
              {addressBook.SECP256K1.addresses.btcP2wpkh ? (
                <LabeledExplorerAddr
                  label="btc p2wpkh"
                  fullValue={addressBook.SECP256K1.addresses.btcP2wpkh}
                  href={hrefForRailAddress(explorerPrefs, networks, 'btc', addressBook.SECP256K1.addresses.btcP2wpkh)}
                  copyLabel="copy btc segwit address"
                />
              ) : null}
              {addressBook.SECP256K1.addresses.btcP2tr ? (
                <LabeledExplorerAddr
                  label="btc p2tr"
                  fullValue={addressBook.SECP256K1.addresses.btcP2tr}
                  href={hrefForRailAddress(explorerPrefs, networks, 'btc', addressBook.SECP256K1.addresses.btcP2tr)}
                  copyLabel="copy btc taproot address"
                />
              ) : null}
            </div>
            <div>
              <div>ED25519 - status: {addressBook.ED25519.status ?? 'not created'}</div>
              <div>supports: {addressBook.ED25519.supports.join(', ')}</div>
              {addressBook.ED25519.addresses.sui ? (
                <LabeledExplorerAddr
                  label="sui"
                  fullValue={addressBook.ED25519.addresses.sui}
                  href={hrefForRailAddress(explorerPrefs, networks, 'sui', addressBook.ED25519.addresses.sui)}
                  copyLabel="copy sui address"
                />
              ) : null}
              {addressBook.ED25519.addresses.solana ? (
                <LabeledExplorerAddr
                  label="solana"
                  fullValue={addressBook.ED25519.addresses.solana}
                  href={hrefForRailAddress(explorerPrefs, networks, 'solana', addressBook.ED25519.addresses.solana)}
                  copyLabel="copy solana address"
                />
              ) : null}
              {addressBook.ED25519.addresses.aptos ? (
                <LabeledExplorerAddr
                  label="aptos"
                  fullValue={addressBook.ED25519.addresses.aptos}
                  href={hrefForRailAddress(explorerPrefs, networks, 'aptos', addressBook.ED25519.addresses.aptos)}
                  copyLabel="copy aptos address"
                />
              ) : null}
            </div>
          </div>
        </div>
      )}

      {showTransferDwallet && (
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 8, color: 'var(--text)' }}>
          transfer dWallet (sender)
        </div>
        <p style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.45, margin: '0 0 8px' }}>
          recipient must have registered their ika encryption key on this network. you will lose the local dWallet row
          after transfer — they complete acceptance in their wallet.
        </p>
        <input
          type="text"
          placeholder="recipient Sui address (0x…)"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          disabled={!enabled || busy}
          className={inputClass}
          style={inputStyle}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
          <button type="button" className={btnPrimary} disabled={!enabled || busy || !recipient.trim()} onClick={doTransfer}>
            transfer share
          </button>
          <button type="button" className={btn} disabled={!enabled || busy} onClick={copySenderAddress}>
            copy my encryption key address
          </button>
        </div>
        {lastDigest && (
          <p style={{ fontSize: 11, wordBreak: 'break-all', marginTop: 8, color: 'var(--theme-banner-success-fg, oklch(0.78 0.16 152))' }}>
            tx digest: {lastDigest}
          </p>
        )}
        {senderKeyAddr && (
          <p style={{ fontSize: 10, wordBreak: 'break-all', marginTop: 4, color: 'var(--faint)' }}>
            encryption key address: {senderKeyAddr}
          </p>
        )}
      </div>
      )}

      {showTransferDwallet && (
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 8, color: 'var(--text)' }}>
          accept transferred dWallet (recipient)
        </div>
        <p style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.45, margin: '0 0 8px' }}>
          verify the sender&apos;s Sui address out-of-band before accepting. paste the transfer tx digest to pull share
          id hints from events (still confirm with sender).
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <input
            type="text"
            placeholder="transfer tx digest"
            value={parseDigest}
            onChange={(e) => setParseDigest(e.target.value)}
            disabled={!enabled || busy}
            className={inputClass}
            style={{ flex: '1 1 200px', marginBottom: 0, ...(inputStyle ?? {}) }}
          />
          <button type="button" className={btn} disabled={!enabled || busy || !parseDigest.trim()} onClick={doParseDigest}>
            parse hints
          </button>
        </div>
        {parseHints && (
          <pre
            style={{
              fontSize: 10,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              margin: '0 0 10px',
              padding: 8,
              borderRadius: 8,
              background: 'color-mix(in oklch, var(--ink, oklch(0.18 0.04 280)) 65%, transparent)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            {parseHints}
          </pre>
        )}
        <input
          type="text"
          placeholder="dWallet object id"
          value={recvDwalletId}
          onChange={(e) => setRecvDwalletId(e.target.value)}
          disabled={!enabled || busy}
          className={inputClass}
          style={inputStyle}
        />
        <input
          type="text"
          placeholder="sender encryption key address (verified OOB)"
          value={recvSenderAddr}
          onChange={(e) => setRecvSenderAddr(e.target.value)}
          disabled={!enabled || busy}
          className={inputClass}
          style={inputStyle}
        />
        <input
          type="text"
          placeholder="source encrypted share id (sender&apos;s old share)"
          value={recvSourceShare}
          onChange={(e) => setRecvSourceShare(e.target.value)}
          disabled={!enabled || busy}
          className={inputClass}
          style={inputStyle}
        />
        <input
          type="text"
          placeholder="destination encrypted share id (from transfer tx)"
          value={recvDestShare}
          onChange={(e) => setRecvDestShare(e.target.value)}
          disabled={!enabled || busy}
          className={inputClass}
          style={inputStyle}
        />
        <button
          type="button"
          className={btnPrimary}
          style={{ marginTop: 8 }}
          disabled={
            !enabled
            || busy
            || !recvDwalletId.trim()
            || !recvSenderAddr.trim()
            || !recvSourceShare.trim()
            || !recvDestShare.trim()
          }
          onClick={doAcceptTransfer}
        >
          accept transferred dWallet
        </button>
      </div>
      )}

      {!enabled && (
        <p style={{ fontSize: 12, color: 'var(--theme-banner-warn-fg, oklch(0.78 0.18 80))', marginTop: 10 }}>fund SUI + IKA on the fee address first.</p>
      )}
      {phaseB && (
        <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, lineHeight: 1.4 }}>
          phase B auto top-up: {phaseB.enabled ? 'flag on (stub)' : 'off'} — {phaseB.summary}
        </p>
      )}
      <p style={{ fontSize: 10, color: 'rgba(234,240,255,0.45)', marginTop: 8, wordBreak: 'break-all' }}>
        build: {BUILD_STAMP}
      </p>
    </section>
  );
}
