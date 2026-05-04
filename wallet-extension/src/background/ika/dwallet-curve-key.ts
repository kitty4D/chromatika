import { Curve } from '@ika.xyz/sdk';
import type { CurveKey } from '@/background/session';

/** map ika `dWallet.curve` (enum / u32 / string) to vault curve keys. */
export function curveKeyFromDWallet(d: { curve?: unknown }): CurveKey | undefined {
  const c = d.curve;
  if (c === Curve.SECP256K1 || c === 'SECP256K1') return 'SECP256K1';
  if (c === Curve.ED25519 || c === 'ED25519') return 'ED25519';
  if (c === 0 || c === '0') return 'SECP256K1';
  if (c === 2 || c === '2') return 'ED25519';
  const k = (c as { $kind?: string } | undefined)?.$kind;
  if (k?.includes('Secp256k1') || k?.includes('SECP256K1')) return 'SECP256K1';
  if (k?.includes('Ed25519') || k?.includes('ED25519')) return 'ED25519';
  return undefined;
}
