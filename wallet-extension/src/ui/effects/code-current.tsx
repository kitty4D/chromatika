import { useEffect, useRef, type ReactNode } from 'react';

/** pool of plausible snippets from the codebase — feel free to swap */
const SNIPPETS = [
  'await trpc.unlockVault.mutate({ password })',
  'const { dkg } = await ika.requestDWalletDKG(tx)',
  'parseSignatureFromSignOutput(bytes, Curve.SECP256K1)',
  'tx.moveCall({ target: `${ika}::coordinator::request_sign` })',
  'keyring.deriveIkaRootSeed(feeKeypair)',
  'presignPool.take(SECP256K1_ECDSA)',
  'const vault = await aesGcm.decrypt(blob, key)',
  'pbkdf2(password, salt, 900_000, "SHA-256")',
  'ethers.Transaction.from(unsignedSerialized)',
  'adapter.ikaClient.ensureInitialized()',
  'dwalletMeta[vaultId] ?? createDwalletMeta()',
  'verifyMessage(keccak256(preimage), signature)',
  'getRequiredCoinAmounts(ikaClient)',
  'tx.transferObjects([splitIka, splitSui], owner)',
  'sharedBus.emit("vault:unlock")',
  'acceptEncryptedUserShare(shareId, capId)',
  'const presign = await ikaClient.getPresign(presignID)',
  'await ikaClient.getEncryptedUserSecretKeyShare(shareID)',
  'await ikaClient.getPartialUserSignature(partialUserSigID)',
  "await ikaClient.getSign(signID, 'SECP256K1', 'ECDSASecp256k1')",
  'const epoch = await ikaClient.getEpoch()',
];

export interface CodeCurrentOptions {
  count?: number;
  minLifespanSec?: number;
  maxLifespanSec?: number;
  peakOpacity?: number;
  peakWidth?: number;
  color?: string;
  colors?: string[];
  colorCycleSec?: number;
  maxBlurPx?: number;
  maxYawDeg?: number;
  maxZPx?: number;
  bendWindow?: number;
  /** restrict drifter y-positions to bands immediately above and below these elements (CSS selectors, queried within the fx root). omit for full-height. */
  targetSelectors?: string[];
  bandPaddingPx?: number;
  bandHeightPx?: number;
}

interface Drifter {
  el: HTMLDivElement;
  dir: 1 | -1;
  y: number;
  bobAmp: number;
  bobSpeed: number;
  bobPhase: number;
  lifespan: number;
  age: number;
  peakAt: number;
  peakWidth: number;
  snippet: string;
  colorPhase: number;
}

export function CodeCurrent({
  children,
  options,
}: {
  children?: ReactNode;
  options?: CodeCurrentOptions;
}) {
  const {
    count = 14,
    minLifespanSec = 14,
    maxLifespanSec = 30,
    // hard ceiling - text should never reach opacity 1
    peakOpacity = 0.78,
    peakWidth = 0.06,
    color = 'rgba(158, 180, 255, 1)',
    colors = [
      'rgba(158, 180, 255, 1)', // blue-lavender
      'rgba(255, 140, 210, 1)', // pink/magenta
      'rgba(140, 255, 210, 1)', // mint
      'rgba(255, 220, 140, 1)', // gold
      'rgba(200, 160, 255, 1)', // violet
      'rgba(140, 220, 255, 1)', // sky
    ],
    colorCycleSec = 14,
    maxBlurPx = 2.4,
    maxYawDeg = 18,
    maxZPx = 90,
    bendWindow = 0.28,
    targetSelectors,
    bandPaddingPx = 5,
    bandHeightPx = 8,
  } = options ?? {};

  const rootRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const layer = layerRef.current;
    const root = rootRef.current;
    if (!layer || !root) return;

    const rand = (min: number, max: number) => min + Math.random() * (max - min);
    const pickSnippet = () => SNIPPETS[Math.floor(Math.random() * SNIPPETS.length)];

    const palette = colors.length > 0 ? colors : [color];
    type RGB = [number, number, number];
    const parseRGB = (s: string): RGB => {
      const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      return m ? [+m[1], +m[2], +m[3]] : [255, 255, 255];
    };
    const parsedPalette: RGB[] = palette.map(parseRGB);

    type Band = { minY: number; maxY: number };
    let bands: Band[] = [];

    function computeBands() {
      const rootEl = rootRef.current;
      if (!rootEl) return;
      if (!targetSelectors?.length) {
        bands = [{ minY: 6, maxY: Math.max(12, rootEl.clientHeight - 24) }];
        return;
      }
      const rootBox = rootEl.getBoundingClientRect();
      const next: Band[] = [];
      for (const sel of targetSelectors) {
        for (const el of Array.from(rootEl.querySelectorAll(sel))) {
          const box = (el as HTMLElement).getBoundingClientRect();
          const topY = box.top - rootBox.top;
          const bottomY = box.bottom - rootBox.top;
          const above: Band = {
            minY: Math.max(0, topY - bandPaddingPx - bandHeightPx),
            maxY: Math.max(0, topY - bandPaddingPx),
          };
          const below: Band = {
            minY: Math.min(rootBox.height, bottomY + bandPaddingPx),
            maxY: Math.min(rootBox.height, bottomY + bandPaddingPx + bandHeightPx),
          };
          if (above.maxY > above.minY + 1) next.push(above);
          if (below.maxY > below.minY + 1) next.push(below);
        }
      }
      // fallback to full-height if no targets matched yet (initial layout frame)
      bands = next.length ? next : [{ minY: 6, maxY: Math.max(12, rootEl.clientHeight - 24) }];
    }
    computeBands();

    const resizeObserver = new ResizeObserver(() => computeBands());
    resizeObserver.observe(root);
    if (targetSelectors?.length) {
      for (const sel of targetSelectors) {
        for (const el of Array.from(root.querySelectorAll(sel))) {
          resizeObserver.observe(el);
        }
      }
    }

    function pickY(): number {
      const b = bands[Math.floor(Math.random() * bands.length)] ?? { minY: 6, maxY: 20 };
      return rand(b.minY, b.maxY);
    }

    function makeDrifter(fresh: boolean): Drifter {
      const el = document.createElement('div');
      el.className = 'fx-drifter';
      const snippet = pickSnippet();
      el.textContent = snippet;
      layer!.appendChild(el);
      const d: Drifter = {
        el,
        dir: Math.random() < 0.5 ? 1 : -1,
        y: pickY(),
        bobAmp: rand(0.6, 2.2),
        bobSpeed: rand(0.18, 0.5),
        bobPhase: rand(0, Math.PI * 2),
        lifespan: rand(minLifespanSec, maxLifespanSec),
        // stagger so they don't all surface at the same frame
        age: fresh ? rand(0, maxLifespanSec) : 0,
        peakAt: rand(0.25, 0.75),
        peakWidth: peakWidth * rand(0.7, 1.4),
        snippet,
        colorPhase: Math.random(),
      };
      return d;
    }

    function respawn(d: Drifter) {
      d.dir = Math.random() < 0.5 ? 1 : -1;
      d.y = pickY();
      d.bobAmp = rand(0.6, 2.2);
      d.bobSpeed = rand(0.18, 0.5);
      d.bobPhase = rand(0, Math.PI * 2);
      d.lifespan = rand(minLifespanSec, maxLifespanSec);
      d.age = 0;
      d.peakAt = rand(0.25, 0.75);
      d.peakWidth = peakWidth * rand(0.7, 1.4);
      d.snippet = pickSnippet();
      d.el.textContent = d.snippet;
      d.colorPhase = Math.random();
    }

    const drifters: Drifter[] = Array.from({ length: count }, () => makeDrifter(true));

    let raf = 0;
    let last = performance.now();
    let running = true;

    function tick(now: number) {
      if (!running) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const w = root!.clientWidth;
      for (const d of drifters) {
        d.age += dt;
        const t = d.age / d.lifespan;
        if (t >= 1) {
          respawn(d);
          continue;
        }
        const textW = d.el.offsetWidth || 200;
        const startX = d.dir > 0 ? -textW - 20 : w + 20;
        const endX = d.dir > 0 ? w + 20 : -textW - 20;
        const x = startX + (endX - startX) * t;
        const yBob = Math.sin(d.age * d.bobSpeed + d.bobPhase) * d.bobAmp;
        const zPeak = (t - d.peakAt) / d.peakWidth;
        const gauss = Math.exp(-(zPeak * zPeak));
        const opacity = peakOpacity * gauss;
        const blur = maxBlurPx * (1 - gauss);
        const phase = Math.max(-1, Math.min(1, (t - d.peakAt) / bendWindow));
        const near = 1 - Math.abs(phase);
        const yawDeg = -d.dir * maxYawDeg * phase;
        const zPx = maxZPx * near;
        d.el.style.transform =
          `translate3d(${x}px, ${d.y + yBob}px, ${zPx}px) rotateY(${yawDeg}deg)`;
        d.el.style.opacity = String(opacity);
        if (parsedPalette.length > 1) {
          const pos = (((d.age / colorCycleSec) + d.colorPhase) % 1 + 1) % 1 * parsedPalette.length;
          const i = Math.floor(pos) % parsedPalette.length;
          const j = (i + 1) % parsedPalette.length;
          const f = pos - Math.floor(pos);
          const a = parsedPalette[i];
          const b = parsedPalette[j];
          const r = Math.round(a[0] + (b[0] - a[0]) * f);
          const g = Math.round(a[1] + (b[1] - a[1]) * f);
          const bch = Math.round(a[2] + (b[2] - a[2]) * f);
          d.el.style.color = `rgb(${r}, ${g}, ${bch})`;
        } else if (!d.el.style.color) {
          d.el.style.color = palette[0];
        }
        // filter creates a stacking context that flattens 3D in chrome - only set when we actually need blur
        if (blur > 0.15) {
          d.el.style.filter = `blur(${blur}px)`;
        } else if (d.el.style.filter !== '') {
          d.el.style.filter = '';
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      for (const d of drifters) d.el.remove();
    };
  }, [
    count,
    minLifespanSec,
    maxLifespanSec,
    peakOpacity,
    peakWidth,
    maxBlurPx,
    maxYawDeg,
    maxZPx,
    bendWindow,
    targetSelectors?.join('|'),
    bandPaddingPx,
    bandHeightPx,
    colors?.join('|'),
    color,
  ]);

  return (
    <div ref={rootRef} className="fx-root" style={{ ['--fx-color' as string]: color }}>
      <div ref={layerRef} className="fx-layer" aria-hidden="true" />
      <div className="fx-content">{children}</div>
    </div>
  );
}
