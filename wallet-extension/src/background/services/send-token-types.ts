/**
 * shared types for the cross-chain Send token-list aggregator. lives in `background/services/` so
 * both the tRPC layer and the UI (via `MainWalletShell` preselect plumbing) can import without
 * pulling background-only code into the bundle.
 */

export type SendTokenScope = 'dwallet' | 'vault' | 'everything';

export type SendTokenChain = 'evm' | 'sui' | 'solana' | 'btc' | 'aptos';

export type SendTokenNetworkFilter = 'all' | SendTokenChain;

/**
 * one row in the Send tab's Select-Token list. same asset on two dWallets
 * produces two rows (each with its own `ownerAddress` + `key`). sort key is
 * `totalUsdValue` DESC; ties fall back to `key` ASC.
 */
export type SendTokenRow = {
  /** stable id: `${chain}:${addressHash8}:${mintOrContractOrSymbol}`. */
  key: string;
  /** chain-specific address (EVM hex / Sui 0x / Solana base58 / BTC bech32 / Aptos hex). */
  ownerAddress: string;
  /**
   * UI label for the source, e.g. "My dWallet 1 (EVM)" / "Vault fee-payer (Sui)" /
   * "Vault (Seeker)". Computed by the aggregator, not the UI.
   */
  ownerLabel: string;
  /**
   * for `dwallet` / `everything` scope rows, the source dWallet object id (or PDA on Solana base).
   * undefined for vault-level rows. used by the SendPage policy-vault join.
   */
  ownerDwalletId?: string;
  chain: SendTokenChain;
  /** human network label, e.g. "Arbitrum One" / "Sui Mainnet" / "Solana Devnet". */
  networkLabel: string;
  /** EVM only. */
  chainId?: number;
  symbol: string;
  name: string;
  decimals: number;
  /** ERC-20 contract (EVM). */
  contractAddress?: string;
  /** SPL mint (Solana). */
  mint?: string;
  /** Sui coin type id, e.g. `0x2::sui::SUI`. */
  coinType?: string;
  iconUrl?: string;
  /** base units as a string (preserves precision past Number.MAX_SAFE_INTEGER). */
  balanceRaw: string;
  /** decimal-formatted, e.g. "1.234500". */
  balanceFormatted: string;
  pricePerTokenUsd: number | null;
  totalUsdValue: number | null;
};

/**
 * Live policy vault state for a single dWallet, keyed by `ownerAddress` in the aggregator output.
 * The Confirm step joins on this to render the gauge + clamp the amount input for natively-priced
 * assets (v0: ETH / MATIC / native SUI / native SOL).
 */
export type SendPolicyLinkSnapshot = {
  dwalletId: string;
  vaultObjectId: string;
  dailyCapMicros: string;
  spentTodayMicros: string;
  remainingMicros: string;
  panicked: boolean;
  coolDownMs: number;
  unfreezeUnlocksAtMs: number;
};

export type SendTokenListResult = {
  rows: SendTokenRow[];
  /** true when at least one probe failed and the result is incomplete (UI surfaces a soft warning). */
  partial: boolean;
  /** keyed by `ownerAddress`; only contains entries for sources that are policy-wrapped. */
  policyLinksByOwner: Record<string, SendPolicyLinkSnapshot>;
};
