/**
 * QR scanner modal for the Send recipient step. Uses the Chrome-native `BarcodeDetector`
 * API plus `navigator.mediaDevices.getUserMedia` - both are available in MV3 extension
 * pages (popup + side panel) without manifest changes; the user gets a one-time camera
 * permission prompt on first use.
 *
 * accepted QR contents:
 *   - bare addresses (0x..., bc1..., base58, sui 0x..)
 *   - URI schemes: `ethereum:0x..`, `solana:..`, `bitcoin:..`, `sui:..`
 *   - names (foo.sui / foo.eth / foo.sol / foo.apt) - passed through; the parent's
 *     debounced resolver picks them up after the field updates
 *
 * URI params (amount, message, etc.) are ignored - chromatika's Send flow has its own
 * amount field. We only extract the address payload.
 */

import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';

type BarcodeValue = { rawValue: string };
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => { detect(source: HTMLVideoElement | ImageBitmap | Blob): Promise<BarcodeValue[]> };

function getBarcodeDetector(): BarcodeDetectorCtor | null {
  // BarcodeDetector lives on the global in modern Chromium; not typed by default. probe at
  // runtime so older browsers / older Chromium just see "not available" + a graceful error.
  const g = globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  return g.BarcodeDetector ?? null;
}

/** strip a `scheme:` prefix + `?query` tail from a URI-encoded QR payload. returns the
 * address-shaped middle. unknown payloads pass through. */
function extractAddressFromQr(raw: string): string {
  const s = raw.trim();
  // strip well-known URI schemes
  const schemeMatch = s.match(/^(ethereum|solana|sui|bitcoin):([^?]+)(\?.*)?$/i);
  if (schemeMatch) {
    return schemeMatch[2]!.trim();
  }
  return s;
}

export function QrScanRecipientModal({
  open,
  onClose,
  onDetected,
}: {
  open: boolean;
  onClose: () => void;
  onDetected: (value: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<InstanceType<BarcodeDetectorCtor> | null>(null);
  const rafRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStarting(true);
    setError(null);

    const Detector = getBarcodeDetector();
    if (!Detector) {
      setError(
        "Your browser doesn't expose the BarcodeDetector API. Update Chrome / Edge to scan QR codes, or paste the address manually.",
      );
      setStarting(false);
      return;
    }
    try {
      detectorRef.current = new Detector({ formats: ['qr_code'] });
    } catch (e) {
      setError(`Could not create QR detector: ${e instanceof Error ? e.message : String(e)}`);
      setStarting(false);
      return;
    }

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => {});
        }
        setStarting(false);

        // poll @ ~4fps via rAF gating; saves a lot of CPU vs detecting every frame.
        let lastScanMs = 0;
        const SCAN_INTERVAL_MS = 250;
        const loop = async () => {
          if (cancelled) return;
          const now = performance.now();
          if (now - lastScanMs >= SCAN_INTERVAL_MS && videoRef.current && detectorRef.current) {
            lastScanMs = now;
            try {
              const matches = await detectorRef.current.detect(videoRef.current);
              if (matches.length > 0 && matches[0]?.rawValue) {
                const payload = extractAddressFromQr(matches[0].rawValue);
                onDetected(payload);
                return; // parent closes the modal
              }
            } catch {
              // BarcodeDetector occasionally throws on bad frames; ignore + keep polling.
            }
          }
          rafRef.current = requestAnimationFrame(() => void loop());
        };
        rafRef.current = requestAnimationFrame(() => void loop());
      } catch (e) {
        setStarting(false);
        const msg = e instanceof Error ? e.message : String(e);
        if (/permission|denied|notallowed/i.test(msg)) {
          setError('Camera permission denied. Allow access in chrome://settings/content/camera, then retry.');
        } else if (/no.*device|notfound/i.test(msg)) {
          setError('No camera found on this device.');
        } else {
          setError(`Camera open failed: ${msg}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      detectorRef.current = null;
    };
  }, [open, onDetected]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Scan QR code for recipient address"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0, 0, 0, 0.78)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={(e) => {
        // close when clicking the dim backdrop (not the inner card).
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: 'var(--sp-bg, #14141c)',
          color: 'var(--theme-page-text, white)',
          borderRadius: 12,
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          maxWidth: 420,
          margin: '0 auto',
          width: '100%',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Camera size={16} aria-hidden />
          <strong style={{ fontSize: 13 }}>Scan recipient QR</strong>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close scanner"
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              padding: 4,
            }}
          >
            <X size={16} />
          </button>
        </div>
        {error ? (
          <div className="sp-error" style={{ fontSize: 12 }}>
            {error}
          </div>
        ) : (
          <>
            <div
              style={{
                position: 'relative',
                width: '100%',
                aspectRatio: '4 / 3',
                background: 'black',
                borderRadius: 8,
                overflow: 'hidden',
              }}
            >
              <video
                ref={videoRef}
                muted
                playsInline
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              {starting && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'rgba(255,255,255,0.85)',
                    fontSize: 11,
                  }}
                >
                  starting camera…
                </div>
              )}
            </div>
            <div className="sp-muted" style={{ fontSize: 11 }}>
              Point your camera at a QR code. Standard URI schemes (ethereum:, solana:, bitcoin:, sui:) and bare addresses
              are both accepted.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
