import type Transport from '@ledgerhq/hw-transport';
import Solana from '@ledgerhq/hw-app-solana';
import { PublicKey } from '@solana/web3.js';

export const LEDGER_SOLANA_DERIVE_PATHS = [
  "m/44'/501'/0'/0'",
  "m/44'/501'/1'/0'",
  "m/44'/501'/0'/1'",
] as const;

export type LedgerSolanaDerivedRow = {
  path: string;
  address: string;
};

export async function deriveLedgerSolanaAccounts(transport: Transport): Promise<LedgerSolanaDerivedRow[]> {
  const sol = new Solana(transport);
  const out: LedgerSolanaDerivedRow[] = [];
  for (const path of LEDGER_SOLANA_DERIVE_PATHS) {
    const { address } = await sol.getAddress(path, false);
    const pk = new PublicKey(address);
    out.push({ path, address: pk.toBase58() });
  }
  return out;
}
