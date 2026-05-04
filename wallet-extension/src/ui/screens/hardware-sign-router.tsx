import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { LedgerSigner } from '@/ui/hardware/LedgerSigner';
import { MwaSigner } from '@/ui/hardware/MwaSigner';
import { TrezorSigner } from '@/ui/hardware/TrezorSigner';
import { WalletConnectSigner } from '@/ui/hardware/WalletConnectSigner';

type Vendor = 'ledger' | 'trezor' | 'mwa' | 'walletconnect';

/**
 * routes a hardware sign popup to the correct signer component based on the request's vendor.
 * fetches the vendor from the sign request metadata (the URL only carries the request ID).
 */
export function HardwareSignRouter({ requestId }: { requestId: string }) {
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    trpc['getHardwareSignRequest'].query({ id: requestId })
      .then((m) => setVendor((m as { vendor: Vendor }).vendor ?? 'ledger'))
      .catch((e) => setFetchError(e instanceof Error ? e.message : String(e)));
  }, [requestId]);

  if (fetchError) {
    return <div className="wc-approvalSheet"><p style={{ color: 'rgba(255,99,132,0.95)' }}>{fetchError}</p></div>;
  }
  if (!vendor) {
    return <div className="wc-approvalSheet"><p>loading request…</p></div>;
  }
  if (vendor === 'walletconnect') return <WalletConnectSigner requestId={requestId} />;
  if (vendor === 'mwa') return <MwaSigner requestId={requestId} />;
  if (vendor === 'trezor') return <TrezorSigner requestId={requestId} />;
  return <LedgerSigner requestId={requestId} />;
}
