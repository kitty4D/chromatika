/**
 * dWallet leaderboard - rendered as a section inside the ChromaLab page.
 *
 * mirrors the standalone page version but drops the page chrome (back button,
 * top-level title) so it composes inside `ChromaLabPage`'s `sp-section` rhythm
 * alongside ink dive, IKA token, encrypt lab, etc. opt-in + first-run modal
 * still live here so users get the same disclosure flow regardless of where
 * the surface is mounted.
 */

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { LoadingState, EmptyState } from '@/ui/components/StateViews';
import { useLeaderboard } from '@/lib/use-leaderboard';
import { LeaderboardTable } from '@/ui/components/leaderboard/LeaderboardTable';
import { LeaderboardRefreshBar } from '@/ui/components/leaderboard/LeaderboardRefreshBar';
import { LeaderboardFirstRunModal } from '@/ui/components/leaderboard/LeaderboardFirstRunModal';
import { AddManualDWalletDialog } from '@/ui/components/leaderboard/AddManualDWalletDialog';

type Prefs = { enabled: boolean };

export function ChromaLabLeaderboardSection() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [showDisclosure, setShowDisclosure] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const got = (await trpc.leaderboardGetPrefs.query()) as Prefs;
        if (!cancelled) setPrefs(got);
      } catch {
        if (!cancelled) setPrefs({ enabled: false });
      } finally {
        if (!cancelled) setPrefsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const onEnable = useCallback(async () => {
    await trpc.leaderboardSetPrefs.mutate({ enabled: true });
    setPrefs({ enabled: true });
    setShowDisclosure(false);
    setRefreshing(true);
    try {
      await trpc.leaderboardRefreshNow.mutate();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  const onDisable = useCallback(async () => {
    await trpc.leaderboardSetPrefs.mutate({ enabled: false });
    setPrefs({ enabled: false });
  }, []);

  const onRefreshClick = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await trpc.leaderboardRefreshNow.mutate();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  const leaderboardActive = prefs?.enabled === true;
  const { rows, total, indexUpdatedAtMs, lastFullScanMs, loading, error, refetch } = useLeaderboard({ limit: 100 });

  return (
    <div className="sp-section">
      <div className="sp-sectionTitle">leaderboard</div>
      <div className="sp-muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.45 }}>
        ranks every observed ika dWallet on the network by total USD across the chain addresses it
        can sign for. discovery uses a paginated <code>DWalletCap</code> object query on Sui (same
        data suivision/suiscan show). policy-vault-wrapped caps and Solana-resident dWallets are
        not yet enumerated.
      </div>

      {!prefsLoaded ? (
        <LoadingState skeleton="rows" count={3} />
      ) : !leaderboardActive ? (
        <EmptyState
          title="leaderboard is off"
          description="enable to start indexing dWallet caps and probing per-chain USD."
          action={
            <button type="button" className="sp-btn sp-btnPrimary" onClick={() => setShowDisclosure(true)}>
              enable leaderboard
            </button>
          }
        />
      ) : (
        <>
          <LeaderboardRefreshBar
            total={total}
            indexUpdatedAtMs={indexUpdatedAtMs}
            lastFullScanMs={lastFullScanMs}
            refreshing={refreshing}
            onRefresh={() => void onRefreshClick()}
            onAddManual={() => setShowAdd(true)}
            onDisable={() => void onDisable()}
          />
          {refreshError && (
            <div className="sp-muted" role="alert" style={{ color: 'rgba(255,99,132,0.95)', fontSize: 11, margin: '4px 0' }}>
              refresh failed: {refreshError}
            </div>
          )}
          {error && (
            <div className="sp-muted" role="alert" style={{ color: 'rgba(255,99,132,0.95)', fontSize: 11, margin: '4px 0' }}>
              list failed: {error}
            </div>
          )}
          {loading && rows.length === 0 ? (
            <LoadingState skeleton="rows" count={6} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="no dWallets indexed yet"
              description="hit refresh to walk the coordinator's DWalletCap pages, or paste an id to track."
              action={
                <button type="button" className="sp-btn sp-btnPrimary" onClick={() => void onRefreshClick()}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <RefreshCw size={14} /> refresh now
                  </span>
                </button>
              }
            />
          ) : (
            <LeaderboardTable rows={rows} onRefreshRow={refetch} />
          )}
        </>
      )}

      {showDisclosure && (
        <LeaderboardFirstRunModal
          onCancel={() => setShowDisclosure(false)}
          onAccept={() => void onEnable()}
        />
      )}

      {showAdd && (
        <AddManualDWalletDialog
          onCancel={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            void refetch();
          }}
        />
      )}
    </div>
  );
}
