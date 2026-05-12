import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { X } from 'lucide-react';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';

export function ReceiveAddressSheet({
  open,
  onClose,
  address,
  label,
  explorerHref,
}: {
  open: boolean;
  onClose: () => void;
  address: string;
  label?: string;
  /** when set, address row links to the chain explorer (prefs + networks from parent). */
  explorerHref?: string | null;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !address.trim()) {
      setDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(address.trim(), {
      width: 220,
      margin: 2,
      errorCorrectionLevel: 'M',
    }).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [open, address]);

  // Escape-to-close for keyboard users.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="dp-receiveBackdrop" role="presentation" onClick={onClose}>
      <div
        className="dp-receiveSheet"
        role="dialog"
        aria-modal="true"
        aria-label="Receive"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dp-receiveSheet-head">
          <span className="dp-receiveSheet-title">receive</span>
          <button type="button" className="dp-receiveClose" aria-label="close" onClick={onClose}>
            <X size={18} strokeWidth={2} />
          </button>
        </div>
        {label ? <div className="dp-receiveSheet-sub">{label}</div> : null}
        <div className="dp-receiveQrWrap">
          {dataUrl ? (
            <img src={dataUrl} alt="" width={220} height={220} className="dp-receiveQr" />
          ) : (
            <div className="dp-receiveQrPlaceholder">generating qr…</div>
          )}
        </div>
        <div className="dp-receiveAddrWrap">
          <ExplorerValueRow
            fullValue={address.trim()}
            href={explorerHref ?? null}
            truncateMid={{ head: 12, tail: 12 }}
            copyLabel="Copy address"
            className="dp-receiveExplorerRow"
          />
        </div>
      </div>
    </div>
  );
}
