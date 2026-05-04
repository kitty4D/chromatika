/**
 * SNS.id (Bonfida proxy) reverse lookup + AllDomains main domain via @onsol/tldparser.
 * pre-alpha: mock-signer / devnet, still safe to call; often returns nothing off mainnet.
 */

import { Buffer } from 'buffer';
import { type AccountInfo, Connection, PublicKey } from '@solana/web3.js';

/** SNS sdk-proxy reverse lookup: wallet pubkey -> `.sol` name string. */
export async function resolveSnsPrimaryName(walletBase58: string): Promise<string | null> {
  try {
    const res = await fetch(`https://sdk-proxy.sns.id/reverse-lookup/${encodeURIComponent(walletBase58)}`);
    if (!res.ok) return null;
    const j = (await res.json()) as { s?: string; result?: string };
    if (j.s !== 'ok' || typeof j.result !== 'string' || !j.result.trim()) return null;
    const name = j.result.trim();
    return name.endsWith('.sol') ? name : `${name}.sol`;
  } catch {
    return null;
  }
}

/** Bonfida-hosted SNS image (may 404; use onError in UI). */
export function snsBonfidaImageUrl(domainDotSol: string): string {
  const d = domainDotSol.trim();
  return `https://sns-img.bonfida.com/name/${encodeURIComponent(d)}`;
}

/** AllDomains "main" domain for a wallet (e.g. `foo.solana`). */
export async function resolveAllDomainsMainName(
  rpcUrl: string,
  walletBase58: string,
): Promise<string | null> {
  try {
    const { MainDomain, findMainDomain } = await import('@onsol/tldparser');
    const connection = new Connection(rpcUrl, 'confirmed');
    const pk = new PublicKey(walletBase58);
    const [mainDomainPubkey] = findMainDomain(pk);
    const acc = await connection.getAccountInfo(mainDomainPubkey);
    if (!acc?.data) return null;
    const accBuf = {
      ...acc,
      data: Buffer.from(acc.data),
    } as AccountInfo<Buffer>;
    const [md] = MainDomain.fromAccountInfo(accBuf);
    if (!md || typeof md.domain !== 'string' || typeof md.tld !== 'string') return null;
    return `${md.domain}${md.tld}`;
  } catch {
    return null;
  }
}
