import { useCallback, useEffect, useId, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Reorder, useDragControls, useReducedMotion } from 'framer-motion';
import '@/ui/wallet-chrome-extras.css';
import type { DwalletHomeGasRow } from '@/background/chains/dwallet-home-gas';
import { trpc } from '@/lib/trpc';
import { applyDwalletCardOrder } from '@/lib/dwallet-card-order';
import { DWalletCard } from '@/ui/components/DWalletCard';
import type { Networks } from '@/ui/types';

type Cap = Awaited<ReturnType<typeof trpc.listOwnedDWalletCaps.query>>[number];

const INSERT_DEAD_PX = 14;

function computeInsertIndex(
  clientY: number,
  ids: readonly string[],
  getBody: (id: string) => HTMLElement | undefined | null,
): number {
  let insert = 0;
  for (let i = 0; i < ids.length; i++) {
    const el = getBody(ids[i]);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    if (clientY >= mid) insert = i + 1;
  }
  return insert;
}

/** hysteresis so the drop slot does not oscillate when the pointer sits on a card midpoint. */
function stableInsertIndex(
  clientY: number,
  ids: readonly string[],
  getBody: (id: string) => HTMLElement | undefined | null,
  prev: number | null,
  deadPx: number,
): number {
  const raw = computeInsertIndex(clientY, ids, getBody);
  if (prev === null) return raw;
  if (raw === prev) return raw;
  if (Math.abs(raw - prev) !== 1) return raw;
  const boundaryIdx = Math.min(prev, raw);
  const el = getBody(ids[boundaryIdx]);
  if (!el) return raw;
  const r = el.getBoundingClientRect();
  const mid = r.top + r.height / 2;
  if (raw > prev) return clientY >= mid + deadPx ? raw : prev;
  return clientY <= mid - deadPx ? raw : prev;
}

function ReorderableRow({
  value,
  index,
  listLen,
  cap,
  networks,
  isActiveMeta,
  displayLabel,
  onNamesChanged,
  onViewPortfolio,
  vaultHomeGasById,
  vaultHomeGasLoading,
  draggingId,
  insertSlot,
  dragSlotPx,
  reduceMotion,
  setDraggingId,
  setInsertSlot,
  setDragSlotPx,
  bodyRefMap,
  reorderIds,
  getBody,
  stableInsertRef,
}: {
  value: string;
  index: number;
  listLen: number;
  cap: Cap;
  networks: Networks | null;
  isActiveMeta?: boolean;
  displayLabel: string;
  onNamesChanged: () => void;
  onViewPortfolio: (dwalletId: string) => void;
  vaultHomeGasById: Record<string, DwalletHomeGasRow[]>;
  vaultHomeGasLoading: boolean;
  draggingId: string | null;
  insertSlot: number | null;
  dragSlotPx: number;
  reduceMotion: boolean;
  setDraggingId: (id: string | null) => void;
  setInsertSlot: (n: number | null) => void;
  setDragSlotPx: (px: number) => void;
  bodyRefMap: MutableRefObject<Map<string, HTMLDivElement>>;
  reorderIds: readonly string[];
  getBody: (id: string) => HTMLElement | undefined | null;
  stableInsertRef: MutableRefObject<number | null>;
}) {
  const controls = useDragControls();
  const dragRafRef = useRef<number | null>(null);
  const pendingDragYRef = useRef<number | null>(null);
  const layoutTransition = reduceMotion
    ? { duration: 0.01 }
    : { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <Reorder.Item
      value={value}
      as="div"
      className="cd-reorderItemWrap"
      dragListener={false}
      dragControls={controls}
      layout="position"
      transition={{ layout: layoutTransition }}
      whileDrag={
        reduceMotion
          ? { zIndex: 40, cursor: 'grabbing' }
          : {
              scale: 1.02,
              zIndex: 40,
              cursor: 'grabbing',
              boxShadow: '0 22px 56px rgba(0, 0, 0, 0.55)',
            }
      }
      onDragStart={() => {
        stableInsertRef.current = null;
        setDraggingId(value);
        const el = bodyRefMap.current.get(value);
        if (el) setDragSlotPx(Math.max(120, el.offsetHeight));
      }}
      onDrag={(_, info) => {
        pendingDragYRef.current = info.point.y;
        if (dragRafRef.current != null) return;
        dragRafRef.current = window.requestAnimationFrame(() => {
          dragRafRef.current = null;
          const y = pendingDragYRef.current;
          if (y == null) return;
          const next = stableInsertIndex(y, reorderIds, getBody, stableInsertRef.current, INSERT_DEAD_PX);
          stableInsertRef.current = next;
          setInsertSlot(next);
        });
      }}
      onDragEnd={() => {
        if (dragRafRef.current != null) {
          window.cancelAnimationFrame(dragRafRef.current);
          dragRafRef.current = null;
        }
        pendingDragYRef.current = null;
        stableInsertRef.current = null;
        setDraggingId(null);
        setInsertSlot(null);
      }}
      style={{ transformOrigin: '50% 50%' }}
    >
      {draggingId && insertSlot === index ? (
        <div className="cd-reorderDropSlot" style={{ minHeight: dragSlotPx }} aria-hidden />
      ) : null}
      <div
        className="cd-reorderItemBody"
        ref={(el) => {
          if (el) bodyRefMap.current.set(value, el);
          else bodyRefMap.current.delete(value);
        }}
      >
        <DWalletCard
          cap={cap}
          networks={networks}
          isActiveMeta={isActiveMeta}
          displayLabel={displayLabel}
          dragControls={controls}
          onNamesChanged={onNamesChanged}
          onViewPortfolio={onViewPortfolio}
          vaultHomeGas={{
            rows: vaultHomeGasById[cap.dwalletId] ?? [],
            loading: vaultHomeGasLoading,
          }}
        />
      </div>
      {draggingId && insertSlot === listLen && index === listLen - 1 ? (
        <div className="cd-reorderDropSlot" style={{ minHeight: dragSlotPx }} aria-hidden />
      ) : null}
    </Reorder.Item>
  );
}

export function DWalletReorderList({
  deckCaps,
  cardOrderIds,
  setCardOrderIds,
  networks,
  metaSecp,
  labelForCap,
  vaultHomeGasById,
  vaultHomeGasLoading,
  onNamesChanged,
  onViewPortfolio,
  onReorderError,
}: {
  /** dWallet cards on vault home: not filtered by ika on-chain `Active` */
  deckCaps: Cap[];
  cardOrderIds: string[];
  setCardOrderIds: (ids: string[]) => void;
  networks: Networks | null;
  metaSecp: string | null;
  labelForCap: (cap: Cap) => string;
  vaultHomeGasById: Record<string, DwalletHomeGasRow[]>;
  vaultHomeGasLoading: boolean;
  onNamesChanged: () => void;
  onViewPortfolio: (dwalletId: string) => void;
  onReorderError: (msg: string) => void;
}) {
  const mergedList = useMemo(() => applyDwalletCardOrder(deckCaps, cardOrderIds), [deckCaps, cardOrderIds]);
  const mergedKey = mergedList.map((c) => c.dwalletId).join('|');
  const [reorderIds, setReorderIds] = useState<string[]>(() => mergedList.map((c) => c.dwalletId));

  useEffect(() => {
    setReorderIds(mergedList.map((c) => c.dwalletId));
  }, [mergedKey]);

  const capById = useMemo(() => new Map(mergedList.map((c) => [c.dwalletId, c])), [mergedList]);
  const bodyRefMap = useRef(new Map<string, HTMLDivElement>());
  const stableInsertRef = useRef<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [insertSlot, setInsertSlot] = useState<number | null>(null);
  const [dragSlotPx, setDragSlotPx] = useState(160);
  const reduceMotion = useReducedMotion();
  const reorderHintId = useId();

  const getBody = useCallback((id: string) => bodyRefMap.current.get(id), []);

  const onReorder = useCallback(
    (next: string[]) => {
      setReorderIds(next);
      setCardOrderIds(next);
      void trpc.setDwalletCardOrder.mutate({ orderedIds: next }).catch((err) => {
        onReorderError(err instanceof Error ? err.message : String(err));
        void trpc.getDwalletCardOrder
          .query()
          .then((r) => setCardOrderIds(r.orderedIds))
          .catch(() => setCardOrderIds([]));
      });
    },
    [onReorderError, setCardOrderIds],
  );

  return (
    <>
      <p id={reorderHintId} className="ch-srOnly">
        To change the order of dWallets in this list, drag the grip on each card with a mouse, touch, or stylus.
        Keyboard reorder is not available in this build.
      </p>
      <Reorder.Group
        axis="y"
        values={reorderIds}
        onReorder={onReorder}
        as="div"
        className="cd-reorderGroup"
        aria-describedby={reorderHintId}
      >
      {reorderIds.map((id, index) => {
        const cap = capById.get(id);
        if (!cap) return null;
        return (
          <ReorderableRow
            key={id}
            value={id}
            index={index}
            listLen={reorderIds.length}
            cap={cap}
            networks={networks}
            isActiveMeta={cap.dwalletId === metaSecp}
            displayLabel={labelForCap(cap)}
            onNamesChanged={onNamesChanged}
            onViewPortfolio={onViewPortfolio}
            vaultHomeGasById={vaultHomeGasById}
            vaultHomeGasLoading={vaultHomeGasLoading}
            draggingId={draggingId}
            insertSlot={insertSlot}
            dragSlotPx={dragSlotPx}
            reduceMotion={Boolean(reduceMotion)}
            setDraggingId={setDraggingId}
            setInsertSlot={setInsertSlot}
            setDragSlotPx={setDragSlotPx}
            bodyRefMap={bodyRefMap}
            reorderIds={reorderIds}
            getBody={getBody}
            stableInsertRef={stableInsertRef}
          />
        );
      })}
    </Reorder.Group>
    </>
  );
}
