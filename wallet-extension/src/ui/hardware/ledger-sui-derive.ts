import type Transport from '@ledgerhq/hw-transport';
import SuiLedger from '@ledgerhq/hw-app-sui';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';

/** default paths shown when pairing Ledger Sui app (align with Mysten / SLIP44 784). */
export const LEDGER_SUI_DERIVE_PATHS = [
  "m/44'/784'/0'/0'/0'",
  "m/44'/784'/0'/0'/1'",
  "m/44'/784'/0'/1'/0'",
] as const;

function u8ToB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s);
}

export type LedgerSuiDerivedRow = {
  path: string;
  address: string;
  ed25519PublicKeyB64: string;
};

export async function deriveLedgerSuiAccounts(transport: Transport): Promise<LedgerSuiDerivedRow[]> {
  const sui = new SuiLedger(transport);
  const derived: LedgerSuiDerivedRow[] = [];
  for (const path of LEDGER_SUI_DERIVE_PATHS) {
    const res = await sui.getPublicKey(path, false);
    const pub = new Uint8Array(res.publicKey);
    const pk = new Ed25519PublicKey(pub);
    const address = pk.toSuiAddress();
    const ed25519PublicKeyB64 = u8ToB64(pub);
    derived.push({ path, address, ed25519PublicKeyB64 });
  }
  return derived;
}
