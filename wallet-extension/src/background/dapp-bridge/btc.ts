import { getSession } from '@/background/session';
import { signMessageBtc } from '@/background/chains/signing';
import { getBitcoinAddresses } from '@/background/chains/bitcoin';
import type { BridgeCtx, HandlerResult } from './internal';

export async function handleBtcMethod(ctx: BridgeCtx): Promise<HandlerResult> {
  const { method, params } = ctx;

  if (method === 'bitcoin_requestAccounts' || method === 'bitcoin_getAccounts') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    const { p2wpkh, p2tr } = await getBitcoinAddresses('mainnet');
    // return both address types - dApps pick the one they need
    const addresses = [
      { address: p2wpkh, publicKey: '', purpose: 'payment' as const },
      { address: p2tr,   publicKey: '', purpose: 'ordinals' as const },
    ];
    return { ok: true, result: { addresses } };
  }

  if (method === 'bitcoin_getNetwork') {
    return { ok: true, result: { network: 'mainnet' } };
  }

  if (method === 'bitcoin_signMessage') {
    const s = getSession();
    if (!s) return { ok: false, error: 'Wallet locked' };
    // params: [address, hexMessage]
    const hexMsg = (params ?? [])[1] as string | undefined ?? (params ?? [])[0] as string;
    const { signature } = await signMessageBtc(hexMsg ?? '');
    return { ok: true, result: { signature } };
  }

  return null;
}
