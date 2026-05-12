import { useEffect, useMemo, useState } from 'react';
import { FlaskConical, Microscope, Waves } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import type { Balances } from '@/ui/types';
import type { IkaBaseMode } from '@/background/ika-base-mode';
import {
  buildSolanaExplorerUrl,
  buildSuiscanCoinTradersUrl,
  buildSuiExplorerUrl,
  DEFAULT_EXPLORER_PREFERENCES,
  type ExplorerPreferences,
} from '@/config/explorers';
import {
  aptosAccountExplorerUrl,
  btcAddressExplorerUrl,
  dwalletObjectExplorerHref,
  evmAddressExplorerUrl,
} from '@/lib/explorer-href';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import { ChromaLabLeaderboardSection } from '@/ui/components/leaderboard/ChromaLabLeaderboardSection';
import type { Networks } from '@/ui/types';
import '@/ui/chroma-lab.css';

type LabRefs = Awaited<ReturnType<typeof trpc.getChromaLabRefs.query>>;
type SuiOverview = Awaited<ReturnType<typeof trpc.getSuiExplorerOverview.query>>;
type SuiDetail = Awaited<ReturnType<typeof trpc.getSuiExplorerDwalletDetail.query>>;
type SolanaOverview = Awaited<ReturnType<typeof trpc.getSolanaProgramRecentOverview.query>>;
type SolanaDetail = Awaited<ReturnType<typeof trpc.getSolanaExplorerDwalletDetail.query>>;
type UnverifiedPresignSample = Awaited<ReturnType<typeof trpc.getUnverifiedPresignCapSample.query>>;

function shortId(id: string, left = 10, right = 8): string {
  if (id.length <= left + right + 1) return id;
  return `${id.slice(0, left)}…${id.slice(-right)}`;
}

function formatTime(ms: number | null): string {
  if (!ms) return 'unknown';
  return new Date(ms).toLocaleString();
}

function openTextLabel(count: number): string {
  return count === 1 ? '1 tx' : `${count} txs`;
}

function isSuiDetail(detail: SuiDetail | SolanaDetail | null): detail is SuiDetail {
  return Boolean(detail && 'publicOutputB64' in detail);
}

function isSolanaDetail(detail: SuiDetail | SolanaDetail | null): detail is SolanaDetail {
  return Boolean(detail && 'publicOutputHex' in detail);
}

function labRailAddressHref(
  prefs: ExplorerPreferences,
  networks: Networks | null,
  suiNetworkId: string,
  solanaNetworkId: string,
  label: string,
  value: string,
): string | null {
  if (!value.trim()) return null;
  const L = label.toLowerCase();
  if (!networks) {
    if (L === 'sui') return buildSuiExplorerUrl(prefs, suiNetworkId, 'address', value);
    if (L === 'solana') return buildSolanaExplorerUrl(prefs, solanaNetworkId, 'address', value);
    return null;
  }
  if (L === 'evm') {
    const net = networks.evm.find((n) => n.chainId === networks.active.evmChainId);
    return evmAddressExplorerUrl(net?.explorerUrl, value);
  }
  if (L.includes('btc')) return btcAddressExplorerUrl(networks, value);
  if (L === 'sui') return buildSuiExplorerUrl(prefs, networks.active.suiNetworkId, 'address', value);
  if (L === 'solana') return buildSolanaExplorerUrl(prefs, networks.active.solNetworkId, 'address', value);
  if (L === 'aptos') return aptosAccountExplorerUrl(networks, value);
  return null;
}

export function ChromaLabPage({
  ikaMode,
  balances,
}: {
  ikaMode: IkaBaseMode;
  balances: Balances | null;
}) {
  const [refs, setRefs] = useState<LabRefs | null>(null);
  const [networks, setNetworks] = useState<Networks | null>(null);
  const [explorerPrefs, setExplorerPrefs] = useState<ExplorerPreferences>(DEFAULT_EXPLORER_PREFERENCES);
  const [suiOverview, setSuiOverview] = useState<SuiOverview | null>(null);
  const [solOverview, setSolOverview] = useState<SolanaOverview | null>(null);
  const [detail, setDetail] = useState<SuiDetail | SolanaDetail | null>(null);
  const [lookupValue, setLookupValue] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [encryptPlain, setEncryptPlain] = useState('42');
  const [encryptNetKeyHex, setEncryptNetKeyHex] = useState('');
  const [encryptCreateBusy, setEncryptCreateBusy] = useState(false);
  const [encryptReadBusy, setEncryptReadBusy] = useState(false);
  const [encryptCreateOut, setEncryptCreateOut] = useState<string | null>(null);
  const [encryptReadId, setEncryptReadId] = useState('');
  const [encryptReadEpoch, setEncryptReadEpoch] = useState('0');
  const [encryptReadOut, setEncryptReadOut] = useState<string | null>(null);
  const [encryptBatchCsv, setEncryptBatchCsv] = useState('1, 2, 3');
  const [encryptBatchBusy, setEncryptBatchBusy] = useState(false);
  const [encryptBatchOut, setEncryptBatchOut] = useState<string | null>(null);
  const [encryptDepositBanner, setEncryptDepositBanner] = useState<string | null>(null);
  const [encryptRoadmapLines, setEncryptRoadmapLines] = useState<string | null>(null);
  const [presignSample, setPresignSample] = useState<UnverifiedPresignSample | null>(null);
  const [presignSampleError, setPresignSampleError] = useState<string | null>(null);

  const encryptLabUnlocked = useMemo(() => {
    if (!balances || balances.locked) return false;
    return ikaMode === 'solana' && balances.ikaBase === 'solana';
  }, [balances, ikaMode]);

  useEffect(() => {
    if (!encryptLabUnlocked) {
      setEncryptDepositBanner(null);
      return;
    }
    void trpc.encryptLabDepositHint
      .query()
      .then((h) => {
        setEncryptDepositBanner(
          `${h.note} · live lab RPC: ${h.vaultIsSolanaIkaBase ? 'yes' : 'no (switch vault to Solana ika base)'}`,
        );
      })
      .catch(() => setEncryptDepositBanner(null));
  }, [encryptLabUnlocked]);

  useEffect(() => {
    if (!encryptLabUnlocked) {
      setEncryptRoadmapLines(null);
      return;
    }
    void Promise.all([
      trpc.encryptSplEncDepositPath.query(),
      trpc.encryptPcTokenPhase3.query(),
      trpc.encryptPcSwapPhase4.query(),
    ])
      .then(([spl, pc3, pc4]) => {
        setEncryptRoadmapLines(
          [
            `spl enc / deposit: ${spl.userFundedV1}`,
            `minimal ata: ${spl.minimalAtaTopUp}`,
            `pc-token (${pc3.status}): ${pc3.note}`,
            `pc-swap (${pc4.status}): ${pc4.note}`,
          ].join('\n'),
        );
      })
      .catch(() => setEncryptRoadmapLines(null));
  }, [encryptLabUnlocked]);

  useEffect(() => {
    if (!balances || balances.locked) return;
    void Promise.all([
      trpc.getChromaLabRefs.query(),
      trpc.getExplorerPreferences.query(),
      trpc.getNetworks.query(),
    ]).then(([labRefs, prefs, nets]) => {
      setRefs(labRefs);
      setExplorerPrefs(prefs);
      setNetworks(nets);
    }).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [balances]);

  useEffect(() => {
    if (!balances || balances.locked) return;
    setDetail(null);
    setLookupValue('');
    setError(null);
    if (ikaMode === 'sui') {
      void trpc.getSuiExplorerOverview.query({ limit: 40 })
        .then(setSuiOverview)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
      setSolOverview(null);
      return;
    }
    void trpc.getSolanaProgramRecentOverview.query({ limit: 12 })
      .then(setSolOverview)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    setSuiOverview(null);
  }, [ikaMode, balances]);

  // network presign caps - only meaningful on Sui base. cleared when we flip to Solana so
  // a stale Sui card doesn't linger under the Solana refs section.
  useEffect(() => {
    if (!balances || balances.locked || ikaMode !== 'sui') {
      setPresignSample(null);
      setPresignSampleError(null);
      return;
    }
    setPresignSampleError(null);
    void trpc.getUnverifiedPresignCapSample.query({ recentLimit: 5, maxPages: 2 })
      .then(setPresignSample)
      .catch((e) => setPresignSampleError(e instanceof Error ? e.message : String(e)));
  }, [ikaMode, balances]);

  const suiNetworkId = refs?.networkIds.sui ?? 'sui-mainnet';
  const solanaNetworkId = refs?.networkIds.solana ?? 'sol-devnet';

  const packages = refs?.sui.packageRefs ?? [];
  const objects = refs?.sui.objectRefs ?? [];
  const solPrograms = refs?.solana.programRefs ?? [];

  const tokenExplorerHref = refs?.sui.ikaCoinType
    ? buildSuiExplorerUrl(explorerPrefs, suiNetworkId, 'coin', refs.sui.ikaCoinType)
    : null;
  const ikaTradersHref =
    explorerPrefs.sui.preset === 'suiscan' && refs?.sui.ikaCoinType
      ? buildSuiscanCoinTradersUrl(suiNetworkId, refs.sui.ikaCoinType)
      : null;
  const suiDetail = isSuiDetail(detail) ? detail : null;
  const solanaDetail = isSolanaDetail(detail) ? detail : null;

  const currentDetailLinks = useMemo(() => {
    if (!detail || !refs) return null;
    if (isSuiDetail(detail)) {
      return {
        explorer: buildSuiExplorerUrl(explorerPrefs, suiNetworkId, 'object', detail.dwalletId),
        tx: detail.previousTransaction
          ? buildSuiExplorerUrl(explorerPrefs, suiNetworkId, 'tx', detail.previousTransaction)
          : null,
      };
    }
    if (!isSolanaDetail(detail)) return null;
    return {
      explorer: buildSolanaExplorerUrl(explorerPrefs, solanaNetworkId, 'address', detail.dwalletId),
      tx: detail.recentSignatures[0]
        ? buildSolanaExplorerUrl(explorerPrefs, solanaNetworkId, 'tx', detail.recentSignatures[0].signature)
        : null,
    };
  }, [detail, explorerPrefs, refs, solanaNetworkId, suiNetworkId]);

  async function runLookup() {
    const trimmed = lookupValue.trim();
    if (!trimmed) return;
    setLookupBusy(true);
    setError(null);
    try {
      if (ikaMode === 'sui') {
        setDetail(await trpc.getSuiExplorerDwalletDetail.query({ dwalletId: trimmed }));
      } else {
        setDetail(await trpc.getSolanaExplorerDwalletDetail.query({ dwalletId: trimmed }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDetail(null);
    } finally {
      setLookupBusy(false);
    }
  }

  async function openSuiDetail(dwalletId: string) {
    setLookupValue(dwalletId);
    setLookupBusy(true);
    setError(null);
    try {
      setDetail(await trpc.getSuiExplorerDwalletDetail.query({ dwalletId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLookupBusy(false);
    }
  }

  if (!balances || balances.locked) {
    return null;
  }

  return (
    <div className="sp-page">
      <div className="lab-hero">
        <div className="lab-kicker">advanced / experimental</div>
        <div className="lab-titleRow">
          <span className="lab-titleIcon" aria-hidden>
            <FlaskConical size={18} strokeWidth={2.2} />
          </span>
          <div>
            <h1 className="lab-title">chroma lab</h1>
            <div className="sp-muted" style={{ fontSize: 12 }}>
              `ink dive` for ika exploration, plus solana-only Encrypt pre-alpha lab surfaces.
            </div>
          </div>
        </div>
      </div>

      {ikaMode === 'solana' && (
        <div className="lab-banner">
          ika on solana and Encrypt are both pre-alpha right now. treat this area as devnet research tooling, not
          production security or privacy. signatures, key handling, and decrypt/read paths can all change before alpha.
        </div>
      )}

      {error ? (
        <div className="lab-banner lab-banner--danger" style={{ marginTop: 12 }}>
          {error}
        </div>
      ) : null}

      <div className="sp-section">
        <div className="sp-sectionTitle">ink dive</div>
        <div className="sp-muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.45 }}>
          {ikaMode === 'sui'
            ? 'sampled on-chain ika reads from the active sui network. rankings are sample-window hints, not lifetime truth.'
            : 'solana pre-alpha program lens. this side is more limited than sui, so the explorer sticks to program refs, recent signatures, and direct account lookup.'}
        </div>

        <div className="lab-card" style={{ marginBottom: 10 }}>
          <div className="lab-cardTitle">lookup dWallet</div>
          <div className="lab-inputRow">
            <input
              className="sp-input"
              placeholder={ikaMode === 'sui' ? '0x… dWallet id' : 'base58 solana dWallet PDA'}
              value={lookupValue}
              onChange={(e) => setLookupValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runLookup();
              }}
            />
            <button type="button" className="sp-btn" disabled={lookupBusy} onClick={() => void runLookup()}>
              {lookupBusy ? 'loading…' : 'open'}
            </button>
          </div>
        </div>

        {suiDetail ? (
          <div className="lab-card" style={{ marginBottom: 10 }}>
            <div className="lab-cardTitle">dWallet detail</div>
            <div className="lab-metrics" style={{ marginBottom: 10 }}>
              <div className="lab-metric">
                <div className="lab-metricLabel">curve</div>
                <div className="lab-metricValue">{suiDetail.curve}</div>
              </div>
              <div className="lab-metric">
                <div className="lab-metricLabel">state</div>
                <div className="lab-metricValue">{suiDetail.stateKind}</div>
              </div>
              <div className="lab-metric">
                <div className="lab-metricLabel">owned here</div>
                <div className="lab-metricValue">{suiDetail.isOwnedByActiveVault ? 'yes' : 'no'}</div>
              </div>
            </div>
            <div style={{ marginBottom: 6 }}>
              <ExplorerValueRow
                fullValue={suiDetail.dwalletId}
                href={dwalletObjectExplorerHref(explorerPrefs, networks, suiDetail.dwalletId)}
                truncateMid={{ head: 12, tail: 10 }}
                copyLabel="copy dWallet object id"
                className="lab-explorerRow"
                linkClassName="cd-explorerMonoLink lab-mono"
              />
            </div>
            {suiDetail.chainAddresses ? (
              <div className="lab-grid" style={{ marginBottom: 10 }}>
                {Object.entries(suiDetail.chainAddresses).map(([label, value]) =>
                  value ? (
                    <div key={label} className="lab-card" style={{ padding: 10 }}>
                      <div className="lab-kicker">{label}</div>
                      <ExplorerValueRow
                        fullValue={value}
                        href={labRailAddressHref(
                          explorerPrefs,
                          networks,
                          suiNetworkId,
                          solanaNetworkId,
                          label,
                          value,
                        )}
                        copyLabel={`copy ${label} address`}
                        linkClassName="cd-explorerMonoLink lab-mono"
                        className="lab-explorerRow"
                      />
                    </div>
                  ) : null,
                )}
              </div>
            ) : null}
            {suiDetail.publicOutputB64 ? (
              <div className="sp-muted" style={{ fontSize: 12, marginBottom: 10 }}>
                public output: <span className="lab-mono">{suiDetail.publicOutputB64}</span>
              </div>
            ) : null}
            {currentDetailLinks?.explorer ? (
              <a className="lab-linkButton" href={currentDetailLinks.explorer} target="_blank" rel="noreferrer">
                open in explorer
              </a>
            ) : null}
            {currentDetailLinks?.tx ? (
              <a className="lab-linkButton" href={currentDetailLinks.tx} target="_blank" rel="noreferrer" style={{ marginLeft: 8 }}>
                previous tx
              </a>
            ) : null}
            {suiDetail.recentTransactions.length > 0 ? (
              <div className="lab-list" style={{ marginTop: 12 }}>
                {suiDetail.recentTransactions.map((tx: SuiDetail['recentTransactions'][number]) => (
                  <div key={tx.digest} className="lab-linkRow">
                    <div className="lab-linkMeta">
                      <div className="lab-linkLabel">{shortId(tx.digest, 12, 10)}</div>
                      <div className="sp-muted" style={{ fontSize: 11 }}>
                        {formatTime(tx.timestampMs)} · {tx.status} · {tx.signal}
                      </div>
                    </div>
                    {buildSuiExplorerUrl(explorerPrefs, suiNetworkId, 'tx', tx.digest) ? (
                      <a
                        className="lab-linkButton"
                        href={buildSuiExplorerUrl(explorerPrefs, suiNetworkId, 'tx', tx.digest)!}
                        target="_blank"
                        rel="noreferrer"
                      >
                        tx
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {solanaDetail ? (
          <div className="lab-card" style={{ marginBottom: 10 }}>
            <div className="lab-cardTitle">solana dWallet detail</div>
            <div className="lab-metrics" style={{ marginBottom: 10 }}>
              <div className="lab-metric">
                <div className="lab-metricLabel">curve</div>
                <div className="lab-metricValue">{solanaDetail.curve}</div>
              </div>
              <div className="lab-metric">
                <div className="lab-metricLabel">lamports</div>
                <div className="lab-metricValue">{solanaDetail.lamports}</div>
              </div>
              <div className="lab-metric">
                <div className="lab-metricLabel">owner</div>
                <div className="lab-metricValue">{shortId(solanaDetail.ownerProgramId, 8, 8)}</div>
              </div>
            </div>
            <div style={{ marginBottom: 6 }}>
              <ExplorerValueRow
                fullValue={solanaDetail.dwalletId}
                href={dwalletObjectExplorerHref(explorerPrefs, networks, solanaDetail.dwalletId)}
                truncateMid={{ head: 12, tail: 10 }}
                copyLabel="copy dWallet object id"
                className="lab-explorerRow"
                linkClassName="cd-explorerMonoLink lab-mono"
              />
            </div>
            <div className="sp-muted" style={{ fontSize: 12, marginBottom: 10 }}>
              public output: <span className="lab-mono">{solanaDetail.publicOutputHex}</span>
            </div>
            {currentDetailLinks?.explorer ? (
              <a className="lab-linkButton" href={currentDetailLinks.explorer} target="_blank" rel="noreferrer">
                open in explorer
              </a>
            ) : null}
          </div>
        ) : null}

        {ikaMode === 'sui' && suiOverview ? (
          <>
            <div className="lab-metrics" style={{ marginBottom: 10 }}>
              <div className="lab-metric">
                <div className="lab-metricLabel">sampled txs</div>
                <div className="lab-metricValue">{suiOverview.sample.transactionCount}</div>
              </div>
              <div className="lab-metric">
                <div className="lab-metricLabel">success</div>
                <div className="lab-metricValue">{suiOverview.sample.successCount}</div>
              </div>
              <div className="lab-metric">
                <div className="lab-metricLabel">failures</div>
                <div className="lab-metricValue">{suiOverview.sample.failureCount}</div>
              </div>
              <div className="lab-metric">
                <div className="lab-metricLabel">coordinator</div>
                <div className="lab-metricValue">{shortId(suiOverview.sample.coordinatorId, 8, 8)}</div>
              </div>
              <div className="lab-metric">
                <div className="lab-metricLabel">raw fetched</div>
                <div className="lab-metricValue">{suiOverview.sample.fetchedRaw}</div>
              </div>
              <div className="lab-metric">
                <div className="lab-metricLabel">deduped</div>
                <div className="lab-metricValue">{suiOverview.sample.dedupedTransactions}</div>
              </div>
              <div className="lab-metric">
                <div className="lab-metricLabel">unique dWallets</div>
                <div className="lab-metricValue">{suiOverview.heuristicSummary.uniqueDwalletIds}</div>
              </div>
            </div>
            <div className="sp-muted" style={{ fontSize: 11, marginBottom: 12, lineHeight: 1.45 }}>
              {suiOverview.heuristicSummary.explain}
            </div>

            {suiOverview.recentTransactions.length > 0 ? (
              <div className="lab-card" style={{ marginBottom: 12 }}>
                <div className="lab-cardTitle">recent merged txs</div>
                <div className="lab-list">
                  {suiOverview.recentTransactions.map((tx) => (
                    <div key={tx.digest} className="lab-linkRow">
                      <div className="lab-linkMeta">
                        <div className="lab-linkLabel">{shortId(tx.digest, 12, 10)}</div>
                        <div className="sp-muted" style={{ fontSize: 11 }}>
                          {formatTime(tx.timestampMs)} · {tx.status} · {tx.signal}
                        </div>
                      </div>
                      {buildSuiExplorerUrl(explorerPrefs, suiNetworkId, 'tx', tx.digest) ? (
                        <a
                          className="lab-linkButton"
                          href={buildSuiExplorerUrl(explorerPrefs, suiNetworkId, 'tx', tx.digest)!}
                          target="_blank"
                          rel="noreferrer"
                        >
                          tx
                        </a>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="lab-grid">
              <div className="lab-card">
                <div className="lab-cardTitle">most recently created</div>
                <div className="lab-list">
                  {suiOverview.lists.mostRecentCreated.map((row) => (
                    <button key={row.dwalletId} type="button" className="lab-listItemBtn" onClick={() => void openSuiDetail(row.dwalletId)}>
                      <div className="lab-listItemTop">
                        <span className="lab-listItemId">{shortId(row.dwalletId)}</span>
                        <span className="lab-pill">{row.stateKind}</span>
                      </div>
                      <div className="sp-muted" style={{ fontSize: 11 }}>
                        {formatTime(row.createdAtMs)}
                      </div>
                    </button>
                  ))}
                  {suiOverview.lists.mostRecentCreated.length === 0 ? <div className="lab-empty">no created dWallets found in the current sample.</div> : null}
                </div>
              </div>

              <div className="lab-card">
                <div className="lab-cardTitle">most txs in sample</div>
                <div className="lab-list">
                  {suiOverview.lists.mostActiveInSample.map((row) => (
                    <button key={row.dwalletId} type="button" className="lab-listItemBtn" onClick={() => void openSuiDetail(row.dwalletId)}>
                      <div className="lab-listItemTop">
                        <span className="lab-listItemId">{shortId(row.dwalletId)}</span>
                        <span className="lab-pill">{openTextLabel(row.txCount)}</span>
                      </div>
                      <div className="sp-muted" style={{ fontSize: 11 }}>
                        last touched {formatTime(row.lastSeenMs)}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="lab-card">
                <div className="lab-cardTitle">most recently touched</div>
                <div className="lab-list">
                  {suiOverview.lists.mostRecentlyTouched.map((row) => (
                    <button key={row.dwalletId} type="button" className="lab-listItemBtn" onClick={() => void openSuiDetail(row.dwalletId)}>
                      <div className="lab-listItemTop">
                        <span className="lab-listItemId">{shortId(row.dwalletId)}</span>
                        <span className="lab-pill">{row.curve}</span>
                      </div>
                      <div className="sp-muted" style={{ fontSize: 11 }}>
                        {formatTime(row.lastSeenMs)}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="lab-card">
                <div className="lab-cardTitle">awaiting signature</div>
                <div className="lab-list">
                  {suiOverview.lists.awaitingSignature.map((row) => (
                    <button key={row.dwalletId} type="button" className="lab-listItemBtn" onClick={() => void openSuiDetail(row.dwalletId)}>
                      <div className="lab-listItemTop">
                        <span className="lab-listItemId">{shortId(row.dwalletId)}</span>
                        <span className="lab-pill">pending</span>
                      </div>
                      <div className="sp-muted" style={{ fontSize: 11 }}>
                        seen {formatTime(row.lastSeenMs)}
                      </div>
                    </button>
                  ))}
                  {suiOverview.lists.awaitingSignature.length === 0 ? <div className="lab-empty">none in the current sample, lol blessedly calm.</div> : null}
                </div>
              </div>
            </div>
          </>
        ) : null}

        {ikaMode === 'solana' && solOverview ? (
          <div className="lab-card" style={{ marginTop: 10 }}>
            <div className="lab-cardTitle">recent ika solana program signatures</div>
            <div className="lab-list">
              {solOverview.recentSignatures.map((row) => {
                const href = buildSolanaExplorerUrl(explorerPrefs, solanaNetworkId, 'tx', row.signature);
                return (
                  <div key={row.signature} className="lab-linkRow">
                    <div className="lab-linkMeta" style={{ minWidth: 0 }}>
                      <ExplorerValueRow
                        fullValue={row.signature}
                        href={href}
                        truncateMid={{ head: 14, tail: 10 }}
                        copyLabel="copy transaction signature"
                        className="lab-explorerRow"
                        linkClassName="cd-explorerMonoLink lab-linkLabel lab-mono"
                      />
                      <div className="sp-muted" style={{ fontSize: 11 }}>
                        slot {row.slot} · {formatTime(row.blockTimeMs)} · {row.status}
                      </div>
                    </div>
                    {href ? (
                      <a className="lab-linkButton" href={href} target="_blank" rel="noreferrer">
                        tx
                      </a>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <ChromaLabLeaderboardSection />

      <div className="sp-section">
        <div className="sp-sectionTitle">{ikaMode === 'sui' ? 'sui ika refs' : 'solana ika refs'}</div>
        <div className="lab-card">
          <div className="lab-cardTitle">{ikaMode === 'sui' ? 'packages + core objects' : 'program ids + grpc'}</div>
          {ikaMode === 'sui' ? (
            <div className="lab-list">
              {[...packages, ...objects].map((row) => {
                const kind = packages.some((pkg) => pkg.id === row.id && pkg.label === row.label) ? 'package' : 'object';
                const href = buildSuiExplorerUrl(explorerPrefs, suiNetworkId, kind, row.id);
                return (
                  <div key={`${row.label}:${row.id}`} className="lab-linkRow">
                    <div className="lab-linkMeta" style={{ minWidth: 0 }}>
                      <div className="lab-linkLabel">{row.label}</div>
                      <ExplorerValueRow
                        fullValue={row.id}
                        href={href}
                        truncateMid={{ head: 10, tail: 8 }}
                        copyLabel={kind === 'package' ? 'copy package id' : 'copy object id'}
                        className="lab-explorerRow"
                        linkClassName="cd-explorerMonoLink sp-muted lab-mono"
                      />
                    </div>
                    {href ? (
                      <a className="lab-linkButton" href={href} target="_blank" rel="noreferrer">
                        open
                      </a>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="lab-list">
              {solPrograms.map((row) => {
                const href = buildSolanaExplorerUrl(explorerPrefs, solanaNetworkId, 'program', row.id);
                return (
                  <div key={row.id} className="lab-linkRow">
                    <div className="lab-linkMeta" style={{ minWidth: 0 }}>
                      <div className="lab-linkLabel">{row.label}</div>
                      <ExplorerValueRow
                        fullValue={row.id}
                        href={href}
                        truncateMid={{ head: 10, tail: 8 }}
                        copyLabel="copy program id"
                        className="lab-explorerRow"
                        linkClassName="cd-explorerMonoLink sp-muted lab-mono"
                      />
                    </div>
                    {href ? (
                      <a className="lab-linkButton" href={href} target="_blank" rel="noreferrer">
                        open
                      </a>
                    ) : null}
                  </div>
                );
              })}
              <div className="lab-linkRow">
                <div className="lab-linkMeta">
                  <div className="lab-linkLabel">ika solana grpc</div>
                  <div className="sp-muted lab-mono" style={{ fontSize: 11 }}>{refs?.solana.grpcUrl}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {ikaMode === 'sui' ? (
          <div className="lab-card" style={{ marginTop: 10 }}>
            <div className="lab-cardTitle">network presigns (unverified)</div>
            <div className="sp-muted" style={{ fontSize: 11, marginBottom: 8, lineHeight: 1.45 }}>
              in-flight presign caps observed on Sui. high counts hint that the network is
              currently processing many presign requests. these caps convert to verified caps
              once the network validates the presign output.
            </div>
            {presignSampleError ? (
              <div className="sp-muted" role="alert" style={{ color: 'rgba(255,99,132,0.95)', fontSize: 11 }}>
                lookup failed: {presignSampleError}
              </div>
            ) : !presignSample ? (
              <div className="sp-muted" style={{ fontSize: 11 }}>loading sample...</div>
            ) : (
              <>
                <div className="lab-metrics" style={{ marginBottom: 10 }}>
                  <div className="lab-metric">
                    <div className="lab-metricLabel">observed</div>
                    <div className="lab-metricValue">
                      {presignSample.observed}
                      {presignSample.truncated ? '+' : ''}
                    </div>
                  </div>
                  <div className="lab-metric">
                    <div className="lab-metricLabel">recent</div>
                    <div className="lab-metricValue">{presignSample.recent.length}</div>
                  </div>
                </div>
                {presignSample.suiscanCollectionUrl ? (
                  <a
                    className="lab-linkButton"
                    href={presignSample.suiscanCollectionUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ marginBottom: 10, display: 'inline-block' }}
                  >
                    open suiscan collection
                  </a>
                ) : (
                  <div className="sp-muted" style={{ fontSize: 11, marginBottom: 10 }}>
                    suiscan collection page is mainnet only; current network is {suiNetworkId}.
                  </div>
                )}
                {presignSample.recent.length > 0 ? (
                  <div className="lab-list">
                    {presignSample.recent.map((row) => {
                      const capHref = buildSuiExplorerUrl(explorerPrefs, suiNetworkId, 'object', row.id);
                      const presignHref = row.presignId
                        ? buildSuiExplorerUrl(explorerPrefs, suiNetworkId, 'object', row.presignId)
                        : null;
                      const dwalletHref = row.dwalletId
                        ? buildSuiExplorerUrl(explorerPrefs, suiNetworkId, 'object', row.dwalletId)
                        : null;
                      return (
                        <div key={row.id} className="lab-linkRow">
                          <div className="lab-linkMeta" style={{ minWidth: 0 }}>
                            <div className="lab-linkLabel">cap</div>
                            <ExplorerValueRow
                              fullValue={row.id}
                              href={capHref}
                              truncateMid={{ head: 10, tail: 8 }}
                              copyLabel="copy presign cap object id"
                              className="lab-explorerRow"
                              linkClassName="cd-explorerMonoLink sp-muted lab-mono"
                            />
                            <div className="sp-muted" style={{ fontSize: 10, marginTop: 4 }}>
                              {row.dwalletId ? (
                                <>
                                  dwallet-bound -{' '}
                                  <a
                                    href={dwalletHref ?? '#'}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="cd-explorerMonoLink"
                                  >
                                    {row.dwalletId.slice(0, 10)}...{row.dwalletId.slice(-6)}
                                  </a>
                                </>
                              ) : (
                                'global presign (ED25519 / Schnorr)'
                              )}
                              {row.presignId ? (
                                <>
                                  {' '}- presign{' '}
                                  <a
                                    href={presignHref ?? '#'}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="cd-explorerMonoLink"
                                  >
                                    {row.presignId.slice(0, 10)}...{row.presignId.slice(-6)}
                                  </a>
                                </>
                              ) : null}
                            </div>
                          </div>
                          {capHref ? (
                            <a className="lab-linkButton" href={capHref} target="_blank" rel="noreferrer">
                              open
                            </a>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="sp-muted" style={{ fontSize: 11 }}>
                    no unverified presign caps in the current sample window. either the network
                    just processed a batch, or our query didn't catch any mid-flight.
                  </div>
                )}
              </>
            )}
          </div>
        ) : null}
      </div>

      {ikaMode === 'sui' && refs ? (
        <div className="sp-section">
          <div className="sp-sectionTitle">IKA token</div>
          <div className="lab-card">
            <div className="lab-cardTitle">IKA on sui</div>
            <div style={{ marginBottom: 10 }}>
              <ExplorerValueRow
                fullValue={refs.sui.ikaCoinType}
                href={tokenExplorerHref}
                // Move coin types look like `0x<32-byte pkg>::ika::IKA`. tail-only
                // truncation collapses to `...:IKA` which loses the package address;
                // head+tail keeps both the pkg prefix and the `::ika::IKA` suffix
                // visible so the type is recognisable at a glance.
                truncateMid={{ head: 12, tail: 14 }}
                copyLabel="copy IKA coin type"
                className="lab-explorerRow"
                linkClassName="cd-explorerMonoLink sp-muted lab-mono"
              />
            </div>
            <div className="lab-grid">
              {tokenExplorerHref ? (
                <a className="lab-linkButton" href={tokenExplorerHref} target="_blank" rel="noreferrer">
                  open IKA coin in your explorer
                </a>
              ) : null}
              {ikaTradersHref ? (
                <a className="lab-linkButton" href={ikaTradersHref} target="_blank" rel="noreferrer">
                  suiscan traders (suiscan preset only)
                </a>
              ) : (
                <div className="sp-muted" style={{ fontSize: 11 }}>
                  traders deep link is suiscan-specific; switch preset to suiscan if you want it.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {ikaMode === 'solana' && !encryptLabUnlocked && refs ? (
        <div className="sp-section">
          <div className="sp-sectionTitle">Encrypt lab</div>
          <p className="sp-muted" style={{ fontSize: 12, lineHeight: 1.55 }}>
            Encrypt gRPC demos need an <strong>unlocked</strong> vault whose ika base is <strong>Solana</strong> (same
            as the global lab mode toggle). switch vault or ika base in settings, then come back.
          </p>
        </div>
      ) : null}

      {encryptLabUnlocked && refs ? (
        <div className="sp-section">
          <div className="sp-sectionTitle">Encrypt lab</div>
          <div className="lab-banner" style={{ marginBottom: 10 }}>
            Encrypt is a separate pre-alpha track from ika MPC signing. treat it as devnet experimentation only - not
            production privacy, not production confidentiality, and definitely not a magic cloak of invincibility.
          </div>
          {encryptDepositBanner ? (
            <div className="sp-muted" style={{ fontSize: 11, marginBottom: 10, lineHeight: 1.45 }}>
              {encryptDepositBanner}
            </div>
          ) : null}
          <div className="lab-grid">
            <div className="lab-card">
              <div className="lab-cardTitle">
                <Microscope size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                endpoints
              </div>
              <div className="sp-muted" style={{ fontSize: 12, lineHeight: 1.55 }}>
                rpc
                <div className="lab-mono">{refs.encrypt.rpcUrl}</div>
              </div>
              <div className="sp-muted" style={{ fontSize: 12, lineHeight: 1.55, marginTop: 8 }}>
                grpc
                <div className="lab-mono">{refs.encrypt.grpcUrl}</div>
              </div>
            </div>
            <div className="lab-card">
              <div className="lab-cardTitle">
                <Waves size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                program
              </div>
              <div style={{ marginBottom: 10 }}>
                <ExplorerValueRow
                  fullValue={refs.encrypt.programId}
                  href={buildSolanaExplorerUrl(explorerPrefs, 'sol-devnet', 'program', refs.encrypt.programId)}
                  copyLabel="copy Encrypt program id"
                  className="lab-explorerRow"
                  linkClassName="cd-explorerMonoLink lab-mono"
                />
              </div>
              {buildSolanaExplorerUrl(explorerPrefs, 'sol-devnet', 'program', refs.encrypt.programId) ? (
                <a
                  className="lab-linkButton"
                  href={buildSolanaExplorerUrl(explorerPrefs, 'sol-devnet', 'program', refs.encrypt.programId)!}
                  target="_blank"
                  rel="noreferrer"
                >
                  open in explorer
                </a>
              ) : null}
            </div>
            <div className="lab-card">
              <div className="lab-cardTitle">grpc: CreateInput</div>
              <div className="sp-muted" style={{ fontSize: 11, marginBottom: 8 }}>
                needs ika base = solana + devnet rpc + fee key. optional 64-char hex overrides the on-chain network
                encryption pubkey guess.
              </div>
              <label className="sp-swapLabel" style={{ marginBottom: 6 }}>
                plain u64 (mock ciphertext)
                <input className="sp-input" value={encryptPlain} onChange={(e) => setEncryptPlain(e.target.value)} />
              </label>
              <label className="sp-swapLabel" style={{ marginBottom: 8 }}>
                network key hex override (optional)
                <input
                  className="sp-input"
                  placeholder="64 hex chars"
                  value={encryptNetKeyHex}
                  onChange={(e) => setEncryptNetKeyHex(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="sp-btn"
                disabled={encryptCreateBusy}
                onClick={() => {
                  setEncryptCreateBusy(true);
                  setEncryptCreateOut(null);
                  setError(null);
                  const n = Number.parseInt(encryptPlain.trim(), 10);
                  void trpc.encryptLabCreateInput
                    .mutate({
                      plainU64: Number.isFinite(n) ? n : 0,
                      networkEncryptionPublicKeyHex: encryptNetKeyHex.trim() || undefined,
                    })
                    .then((r) => {
                      setEncryptCreateOut(`${r.ciphertextIdentifierHex}\n${r.rawResponseNote}`);
                      setEncryptReadId(r.ciphertextIdentifierHex);
                    })
                    .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                    .finally(() => setEncryptCreateBusy(false));
                }}
              >
                {encryptCreateBusy ? 'calling…' : 'run CreateInput'}
              </button>
              {encryptCreateOut ? (
                <pre className="lab-mono" style={{ fontSize: 10, marginTop: 8, whiteSpace: 'pre-wrap' }}>
                  {encryptCreateOut}
                </pre>
              ) : null}
            </div>
            <div className="lab-card">
              <div className="lab-cardTitle">grpc: CreateInput (batch)</div>
              <div className="sp-muted" style={{ fontSize: 11, marginBottom: 8 }}>
                comma-separated u64 literals (max 16). one gRPC round-trip, same mock ciphertext style as single
                CreateInput.
              </div>
              <label className="sp-swapLabel" style={{ marginBottom: 8 }}>
                plain u64 list
                <input className="sp-input" value={encryptBatchCsv} onChange={(e) => setEncryptBatchCsv(e.target.value)} />
              </label>
              <button
                type="button"
                className="sp-btn"
                disabled={encryptBatchBusy}
                onClick={() => {
                  setEncryptBatchBusy(true);
                  setEncryptBatchOut(null);
                  setError(null);
                  const parts = encryptBatchCsv
                    .split(/[,;\s]+/)
                    .map((x) => x.trim())
                    .filter(Boolean);
                  const plainU64s = parts.map((p) => Number.parseInt(p, 10)).filter((n) => Number.isFinite(n) && n >= 0);
                  void trpc.encryptLabCreateInputBatch
                    .mutate({
                      plainU64s: plainU64s.length ? plainU64s : [0],
                      networkEncryptionPublicKeyHex: encryptNetKeyHex.trim() || undefined,
                    })
                    .then((r) => {
                      setEncryptBatchOut(`${r.ciphertextIdentifierHexes.join('\n')}\n${r.rawResponseNote}`);
                    })
                    .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                    .finally(() => setEncryptBatchBusy(false));
                }}
              >
                {encryptBatchBusy ? 'calling…' : 'run batch CreateInput'}
              </button>
              {encryptBatchOut ? (
                <pre className="lab-mono" style={{ fontSize: 10, marginTop: 8, whiteSpace: 'pre-wrap' }}>
                  {encryptBatchOut}
                </pre>
              ) : null}
            </div>
            <div className="lab-card">
              <div className="lab-cardTitle">grpc: ReadCiphertext</div>
              <div className="sp-muted" style={{ fontSize: 11, marginBottom: 8 }}>
                signed read path only in this lab (signMessageSol on the fee key). public ciphertext reads are a
                separate Encrypt server path when the handle is public; see Encrypt quick start.
              </div>
              <label className="sp-swapLabel" style={{ marginBottom: 6 }}>
                ciphertext id (hex)
                <input className="sp-input" value={encryptReadId} onChange={(e) => setEncryptReadId(e.target.value)} />
              </label>
              <label className="sp-swapLabel" style={{ marginBottom: 8 }}>
                epoch (decimal string)
                <input className="sp-input" value={encryptReadEpoch} onChange={(e) => setEncryptReadEpoch(e.target.value)} />
              </label>
              <button
                type="button"
                className="sp-btn"
                disabled={encryptReadBusy}
                onClick={() => {
                  setEncryptReadBusy(true);
                  setEncryptReadOut(null);
                  setError(null);
                  void trpc.encryptLabReadCiphertext
                    .mutate({
                      ciphertextIdentifierHex: encryptReadId.trim(),
                      epochDecimal: encryptReadEpoch.trim() || undefined,
                    })
                    .then((r) => {
                      setEncryptReadOut(
                        `fhe_type ${r.fheType}\nvalue_hex ${r.valueHex}\ndigest_hex ${r.digestHex}\n---\n${r.readPathNote}`,
                      );
                    })
                    .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                    .finally(() => setEncryptReadBusy(false));
                }}
              >
                {encryptReadBusy ? 'calling…' : 'run ReadCiphertext'}
              </button>
              {encryptReadOut ? (
                <pre className="lab-mono" style={{ fontSize: 10, marginTop: 8, whiteSpace: 'pre-wrap' }}>
                  {encryptReadOut}
                </pre>
              ) : null}
            </div>
            <div className="lab-card">
              <div className="lab-cardTitle">docs</div>
              <a
                className="lab-linkButton"
                href="https://docs.encrypt.xyz/introduction.html"
                target="_blank"
                rel="noreferrer"
              >
                Encrypt docs
              </a>
            </div>
            <div className="lab-card">
              <div className="lab-cardTitle">roadmap stubs (tRPC)</div>
              <div className="sp-muted" style={{ fontSize: 11, marginBottom: 8 }}>
                spl enc deposit notes + pc-token / pc-swap placeholders (Solana ika-base only).
              </div>
              {encryptRoadmapLines ? (
                <pre className="lab-mono" style={{ fontSize: 10, marginTop: 4, whiteSpace: 'pre-wrap' }}>
                  {encryptRoadmapLines}
                </pre>
              ) : (
                <div className="sp-muted" style={{ fontSize: 11 }}>
                  loading…
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
