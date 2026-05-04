/**
 * list classic SPL token holdings at any Solana `owner` on a caller-provided `connection`.
 * two callers today:
 *   - send UI: pass the **dWallet Vault's fee-payer address** + fee-payer connection so users can
 *     recover any SPL tokens (e.g. devnet USDC) that landed at the vault address by mistake.
 *   - dWallet portfolio: pass the **MPC dWallet's derived Solana address** + dWallet-tier
 *     connection so on devnet the portfolio surfaces tokens with no metadata service ("unknown
 *     assets") that wouldn't otherwise appear anywhere in the UI.
 *
 * Token-2022 is intentionally not included, its program id is different and metadata layout
 * extensions complicate parsing. add a parallel call against `TOKEN_2022_PROGRAM_ID` if needed.
 */

import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { SPL_TOKEN_PROGRAM_ID } from '@/background/encrypt-pc/pc-token-spl-ata';

export type SplBalanceRow = {
  /** mint address (base58). */
  mint: string;
  /** ATA holding this mint (base58). useful for debugging, UI doesn't need it. */
  ataAddress: string;
  /** decimals as reported by the mint. */
  decimals: number;
  /** decimal-formatted balance (e.g. "1.234500"). */
  balance: string;
  /** raw u64 base-unit balance as a string (preserves precision past Number.MAX_SAFE_INTEGER). */
  balanceRaw: string;
};

/**
 * returns non-zero classic-SPL token balances at `owner` on `connection`. empty ATAs (closed
 * but not yet gc'd) are filtered out, the user only sees what they can actually spend.
 */
export async function listSolanaSplBalances(owner: string, connection: Connection): Promise<SplBalanceRow[]> {
  const ownerPubkey = new PublicKey(owner.trim());

  const resp = await connection.getParsedTokenAccountsByOwner(
    ownerPubkey,
    { programId: SPL_TOKEN_PROGRAM_ID },
    'confirmed',
  );

  const rows: SplBalanceRow[] = [];
  for (const { pubkey, account } of resp.value) {
    // `account.data` is parsed because we asked via getParsedTokenAccountsByOwner.
    const parsed = (account.data as { parsed?: { info?: unknown } } | null)?.parsed;
    const info = parsed?.info as
      | {
          mint?: string;
          tokenAmount?: { amount?: string; decimals?: number; uiAmountString?: string };
        }
      | undefined;
    const mint = info?.mint;
    const decimals = info?.tokenAmount?.decimals;
    const amount = info?.tokenAmount?.amount;
    const uiAmountString = info?.tokenAmount?.uiAmountString;
    if (!mint || typeof decimals !== 'number' || !amount) continue;
    if (amount === '0') continue;
    rows.push({
      mint,
      ataAddress: pubkey.toBase58(),
      decimals,
      balance: uiAmountString ?? amount,
      balanceRaw: amount,
    });
  }

  // stable order: largest raw balance first, ties broken by mint string.
  rows.sort((a, b) => {
    const da = BigInt(b.balanceRaw) - BigInt(a.balanceRaw);
    if (da !== 0n) return da > 0n ? 1 : -1;
    return a.mint.localeCompare(b.mint);
  });

  return rows;
}
