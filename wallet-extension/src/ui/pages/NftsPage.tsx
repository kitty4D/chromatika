import { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import type { MediaSafetyMode } from '@/background/services/media-safety';
import type { NftItem } from '@/background/services/nft';
import type { Balances } from '@/ui/types';
import { EmptyState, LoadingState } from '@/ui/components/StateViews';

type NftView = 'nfts' | 'kiosks';

type KioskSummary = {
  kioskIds: string[];
  kioskOwnerCaps: { objectId: string; kioskId: string; isPersonal?: boolean }[];
};

/** sui kiosk list (used from Assets page kiosks tab). */
export function KioskPanel({ balances }: { balances: Balances | null }) {
  const [kiosks, setKiosks] = useState<KioskSummary | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [kioskData, setKioskData] = useState<
    Record<string, { items: { objectId: string; type: string; isListed: boolean }[] }>
  >({});
  const [loading, setLoading] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);

  const rawAddr = balances && !balances.locked ? balances.canonicalReceiveAddress : null;
  const address = typeof rawAddr === 'string' && rawAddr.trim().length > 0 ? rawAddr : null;

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    trpc.getOwnedKiosks
      .query({ address })
      .then((r) => setKiosks(r as KioskSummary))
      .catch(() => setKiosks({ kioskIds: [], kioskOwnerCaps: [] }))
      .finally(() => setLoading(false));
  }, [address]);

  async function expandKiosk(id: string) {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (kioskData[id]) return;
    setLoadingDetail(id);
    try {
      const data = await trpc.getKioskData.query({ kioskId: id });
      setKioskData((prev) => ({ ...prev, [id]: data as unknown as (typeof prev)[string] }));
    } finally {
      setLoadingDetail(null);
    }
  }

  if (!address) return <EmptyState icon="🔒" title="unlock wallet to view kiosks" />;
  if (loading) return <LoadingState title="loading kiosks…" skeleton="rows" count={3} />;
  if (!kiosks || kiosks.kioskIds.length === 0) {
    return (
      <EmptyState
        icon="🏪"
        title="no kiosks found"
        description="sui kiosks owned or managed by this address appear here"
      />
    );
  }

  return (
    <div className="sp-kioskList">
      {kiosks.kioskIds.map((id) => {
        const cap = kiosks.kioskOwnerCaps.find((c) => c.kioskId === id);
        const detail = kioskData[id];
        const isOpen = expanded === id;
        return (
          <div key={id} className="sp-kioskCard">
            <button type="button" className="sp-kioskHeader" onClick={() => expandKiosk(id)}>
              <div className="sp-kioskId" title={id}>
                {id.slice(0, 10)}…{id.slice(-6)}
              </div>
              <div className="sp-kioskMeta">
                {cap?.isPersonal && <span className="sp-kioskBadge">personal</span>}
                {detail && <span className="sp-kioskCount">{detail.items.length} items</span>}
                {loadingDetail === id && <span className="sp-kioskCount">loading…</span>}
                <span className="sp-kioskChevron">{isOpen ? '▲' : '▼'}</span>
              </div>
            </button>
            {isOpen && detail && (
              <div className="sp-kioskItems">
                {detail.items.length === 0 && (
                  <div className="sp-muted" style={{ padding: '8px 0', fontSize: 12 }}>
                    kiosk is empty
                  </div>
                )}
                {detail.items.map((item) => (
                  <div key={item.objectId} className="sp-kioskItem">
                    <div className="sp-kioskItemId" title={item.objectId}>
                      {item.objectId.slice(0, 10)}…
                    </div>
                    <div className="sp-kioskItemType">{item.type.split('::').pop() ?? item.type}</div>
                    {item.isListed && <span className="sp-kioskBadge sp-kioskBadgeListed">listed</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NftCard({ nft }: { nft: NftItem }) {
  return (
    <div className="sp-nftCard">
      <div className="sp-nftImg">
        {nft.imageUrl ? (
          <img src={nft.imageUrl} alt={nft.name} loading="lazy" />
        ) : (
          <div className="sp-nftImgPlaceholder">🖼</div>
        )}
      </div>
      <div className="sp-nftName">{nft.name}</div>
      {nft.collectionName && <div className="sp-nftCollection">{nft.collectionName}</div>}
    </div>
  );
}

type NftChain = 'sui' | 'btc' | 'evm' | 'sol' | 'apt';

/** NFT grid + chain toggle (embedded in Assets page nfts tab). */
export function NftsCollectiblesPanel({ balances }: { balances: Balances | null }) {
  const [nfts, setNfts] = useState<NftItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [safetyMode, setSafetyMode] = useState<MediaSafetyMode>('ipfs_arweave');
  const [chain, setChain] = useState<NftChain>('sui');
  const [hints, setHints] = useState<{ alchemyConfigured: boolean; heliusConfigured: boolean } | null>(null);

  useEffect(() => {
    trpc.getMediaSafetyMode.query().then(setSafetyMode).catch(() => {});
  }, []);

  useEffect(() => {
    trpc.getNftApiHints.query().then(setHints).catch(() => {});
  }, []);

  async function load() {
    if (!balances || balances.locked) return;
    setLoading(true);
    setNfts(null);
    try {
      const nets = await trpc.getNetworks.query();
      let items: NftItem[] = [];
      if (chain === 'sui') {
        const suiAddr = balances.canonicalReceiveAddress;
        if (typeof suiAddr !== 'string' || !suiAddr.trim()) {
          setNfts([]);
          return;
        }
        items = (await trpc.getSuiNfts.query({ address: suiAddr.trim() })) as NftItem[];
      } else if (chain === 'btc') {
        const btcNet = nets.active.btcNetworkId === 'btc-mainnet' ? 'mainnet' : 'testnet';
        const { p2wpkh } = await trpc.getBtcAddresses.query({ network: btcNet });
        items = (await trpc.getBtcOrdinals.query({ address: p2wpkh })) as NftItem[];
      } else if (chain === 'evm') {
        const evmAddr = await trpc.getEvmAddress.query();
        items = (await trpc.getEvmNfts.query({
          address: evmAddr,
          chainId: nets.active.evmChainId,
        })) as NftItem[];
      } else if (chain === 'sol') {
        const solAddr = await trpc.getSolanaAddress.query();
        items = (await trpc.getSolanaNfts.query({ address: solAddr })) as NftItem[];
      } else {
        const aptAddr = await trpc.getAptosAddress.query();
        items = (await trpc.getAptosNfts.query({ address: aptAddr })) as NftItem[];
      }
      setNfts(items);
    } catch {
      setNfts([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="sp-row" style={{ marginBottom: 12 }}>
        <div className="sp-chipRow" style={{ flex: 1, flexWrap: 'wrap' }}>
          {(['sui', 'btc', 'evm', 'sol', 'apt'] as const).map((c) => (
            <button
              key={c}
              type="button"
              className={`sp-chip${chain === c ? ' sp-chipActive' : ''}`}
              onClick={() => setChain(c)}
            >
              {c}
            </button>
          ))}
        </div>
        <button type="button" className="sp-btn" onClick={load} disabled={loading}>
          {loading ? 'loading…' : 'load'}
        </button>
      </div>

      {hints && chain === 'evm' && !hints.alchemyConfigured && (
        <div className="sp-muted" style={{ fontSize: 11, marginBottom: 8, color: 'rgba(251, 191, 36, 0.95)' }}>
          evm collectibles need VITE_ALCHEMY_KEY in the build (empty result otherwise).
        </div>
      )}
      {hints && chain === 'sol' && !hints.heliusConfigured && (
        <div className="sp-muted" style={{ fontSize: 11, marginBottom: 8, color: 'rgba(251, 191, 36, 0.95)' }}>
          solana collectibles need VITE_HELIUS_KEY in the build (empty result otherwise).
        </div>
      )}

      <div className="sp-safetyBadge">safety: {safetyMode.replace('_', '/')}</div>

      {nfts === null && !loading && (
        <EmptyState
          icon="🖼"
          title="click load to fetch nfts"
          description="images filtered by media safety mode"
        />
      )}

      {nfts !== null && nfts.length === 0 && (
        <EmptyState icon="🖼" title={`no nfts found on ${chain}`} />
      )}

      {nfts && nfts.length > 0 && (
        <div className="sp-nftGrid">
          {nfts.map((nft) => (
            <NftCard key={nft.id} nft={nft} />
          ))}
        </div>
      )}
    </>
  );
}

export function NftsPage({ balances }: { balances: Balances | null }) {
  const [view, setView] = useState<NftView>('nfts');

  return (
    <div className="sp-page">
      <div className="sp-pageTitle">collectibles</div>

      <div className="sp-chipRow" style={{ marginBottom: 14 }}>
        {(['nfts', 'kiosks'] as const).map((v) => (
          <button
            key={v}
            type="button"
            className={`sp-chip${view === v ? ' sp-chipActive' : ''}`}
            onClick={() => setView(v)}
          >
            {v}
          </button>
        ))}
      </div>

      {view === 'kiosks' && <KioskPanel balances={balances} />}

      {view === 'nfts' && <NftsCollectiblesPanel balances={balances} />}
    </div>
  );
}
