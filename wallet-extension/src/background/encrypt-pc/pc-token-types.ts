/**
 * PC-Token shared types + structured error class. surfaces specific failure reasons so the UI
 * can render targeted copy (especially "recipient hasn't onboarded yet" - a common failure
 * mode that needs a clear deeplink rather than a generic error).
 */

export type PcTokenErrorReason =
  /** PC_TOKEN_PROGRAM_ID_B58 is still the sentinel value; feature is gated. */
  | 'not-configured'
  /** active vault is not a Solana ika base - encrypt.xyz only ships on solana for now. */
  | 'wrong-base-chain'
  /** user's pcToken account hasn't been initialized yet for this mint; needs InitializeAccount. */
  | 'sender-account-uninitialized'
  /** recipient's pcToken account hasn't been initialized; sender must surface a "share onboarding link" message. */
  | 'recipient-account-uninitialized'
  /** balance pre-check failed: requested transfer amount > current decrypted balance. avoids silent no-op (Transfer disc 3 returns success on insufficient balance). */
  | 'insufficient-balance'
  /** devnet wipe rotated ciphertexts; user's stored balance ciphertext_id is gone. */
  | 'devnet-wipe'
  /** Encrypt executor decryption request timed out (default 120s). */
  | 'executor-decrypt-timeout'
  /** general gRPC / protocol error. */
  | 'protocol-error'
  /** vault locked at the time the flow needs an ika sign. */
  | 'wallet-locked';

export class PcTokenError extends Error {
  constructor(
    readonly reason: PcTokenErrorReason,
    message: string,
  ) {
    super(`[pc-token/${reason}] ${message}`);
    this.name = 'PcTokenError';
  }
}

/**
 * the per-mint pcToken record. persisted in chrome.storage when the user initializes an account
 * so subsequent flows can fast-path the PDA lookup.
 */
export interface PcTokenAccountRef {
  /** base58 SPL mint address (e.g. devnet USDC). */
  splMintB58: string;
  /** base58 pcMint PDA (deterministic per mint authority). */
  pcMintB58: string;
  /** base58 TokenAccount PDA (deterministic per mint, owner). */
  tokenAccountB58: string;
  /** base58 vault PDA (deterministic per pcMint). */
  vaultB58: string;
  /** base58 vault SPL ATA (escrow holding wrapped SPL). */
  vaultAtaB58: string;
  /** when this entry was created. ms-since-epoch. */
  createdAtMs: number;
}

export interface PcWrapInput {
  /** SPL mint address (base58). v0 ships USDC-only; this argument exists for future-proofing. */
  splMint: string;
  /** amount in base units (6-decimal USDC: 1 USDC = 1_000_000). decimal strings to avoid bigint serialization on the tRPC boundary. */
  amountBaseUnits: string;
}

export interface PcWrapResult {
  /** Solana tx signature (base58). */
  signature: string;
  /** whether we just initialized the user's pcToken account in the same flow. UI shows a one-time "account opened" toast. */
  accountInitializedInFlow: boolean;
  /** the TokenAccount PDA for this user + mint. */
  tokenAccountB58: string;
}

export interface PcHiddenTransferInput {
  /** mint to transfer. */
  splMint: string;
  /** recipient's solana address (base58). chromatika derives their pcToken PDA from this. */
  recipientSolAddress: string;
  /** amount in base units. */
  amountBaseUnits: string;
}

export interface PcHiddenTransferResult {
  signature: string;
  /** TokenAccount PDA on the sender side; useful for activity-feed correlation. */
  senderTokenAccountB58: string;
  /** TokenAccount PDA on the recipient side. */
  recipientTokenAccountB58: string;
}

export interface PcUnwrapInput {
  splMint: string;
  amountBaseUnits: string;
}

export interface PcUnwrapStepResult {
  step: 'burn' | 'decrypt-wait' | 'complete';
  /** tx signature for `burn` and `complete`. `decrypt-wait` returns the request account pubkey. */
  signature?: string;
  /** pubkey of the DecryptionRequest keypair-account (base58). polled in step 2. */
  decryptRequestB58?: string;
  /** final SPL amount released (base units). populated only on `complete`. */
  releasedAmountBaseUnits?: string;
}

export interface PcBalance {
  /** SPL mint address. */
  splMint: string;
  /** base units (e.g. USDC: divide by 1_000_000 for human-readable). string to avoid bigint at the tRPC boundary. */
  balanceBaseUnits: string;
  /** when the decrypt round-trip last ran. ms-since-epoch. */
  decryptedAtMs: number;
  /** whether the user's pcToken account exists at all. false = needs InitializeAccount. */
  accountExists: boolean;
}

export interface PcDisclaimerAck {
  /** acknowledged by the user on this vault. re-prompted when switching vaults. */
  ackVaultId: string;
  /** ms-since-epoch when ack was recorded. audit trail. */
  ackAtMs: number;
}
