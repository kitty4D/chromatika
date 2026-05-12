/**
 * Sui transaction builders for `chromatika_policy::sign_gate`. constructs PTBs that the
 * caller (chromatika's send service) signs + executes via the existing ika fee-payer
 * keypair (Sui base) flow. all builders take the `packageId` from
 * `chromatika_policy_package_v1` storage; the caller resolves it.
 *
 * two flavors of builder:
 *   - **mutation builders** (`build...Tx`) return an unsigned `Transaction`. caller signs +
 *     executes. used for opt-in, panic, unfreeze, setters, replenish-presign.
 *   - **sign-flow builders** (`buildSignWithPolicyTx`, `buildRescueSignTx`) compose with
 *     the existing IkaTransaction + presign + msg-sig pipeline. they return a `Transaction`
 *     ready to sign; the actual ika MPC wait happens after broadcast (same as today's flow).
 *
 * the on-chain `MessageApproval` produced by `coordinator.approve_message` is a hot-potato
 * value, so the policy module's `sign_with_policy` MUST consume it in the same Move call.
 * callers therefore pass `message` + `hash_scheme` + `signature_algorithm` to the builder;
 * the builder threads them straight into the `sign_with_policy` Move call.
 */

import { Transaction } from '@mysten/sui/transactions';

const MODULE_NAME = 'sign_gate';

/** build a `wrap_dwallet_cap` opt-in PTB. caller provides the dWallet cap object id + initial fund. */
export function buildOptInTx(args: {
  packageId: string;
  dwalletCapObjectId: string;
  /** network encryption key id (lookup via `ikaClient.getLatestNetworkEncryptionKey()`). */
  dwalletNetworkEncryptionKeyId: string;
  /** curve number (SECP256K1=0, SECP256R1=1, ED25519=2, RISTRETTO=3). */
  curve: number;
  /** signature algorithm number per curve. */
  signatureAlgorithm: number;
  /** daily cap in micro-USD (1 USD = 1_000_000). 0 = no cap. */
  dailyCapMicros: bigint;
  /** min ms between successive sign calls. 0 = no cool-down. */
  coolDownMs: bigint;
  /** min ms between panic and unfreeze. hardcoded floor of 0 in Move; UI defaults to 7d. */
  unfreezeDelayMs: bigint;
  /** optional pre-registered rescue address bytes. null = no rescue path. */
  rescueAddressBytes: Uint8Array | null;
  /**
   * stage delay for the cap-increase staged delay opt-in safety. default 24h. user can
   * raise (immediate) or lower (staged) later via `set_stage_delay_ms`. independent of
   * `unfreezeDelayMs`.
   */
  stageDelayMs: bigint;
  /** initial IKA coin object id (split or owned). */
  ikaCoinObjectId: string;
  /** initial SUI coin object id; if null, splits from gas. */
  suiCoinObjectId: string | null;
  /** initial IKA amount to fund (mist). */
  initialIkaMist: bigint;
  /** initial SUI amount to fund (mist). */
  initialSuiMist: bigint;
}): Transaction {
  const tx = new Transaction();

  // split initial IKA + SUI from the supplied coins (gas if SUI coin id is null).
  const [ikaCoin] = tx.splitCoins(tx.object(args.ikaCoinObjectId), [args.initialIkaMist]);
  const suiSource = args.suiCoinObjectId ? tx.object(args.suiCoinObjectId) : tx.gas;
  const [suiCoin] = tx.splitCoins(suiSource, [args.initialSuiMist]);

  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::wrap_dwallet_cap`,
    arguments: [
      tx.object(args.dwalletCapObjectId),
      tx.pure.id(args.dwalletNetworkEncryptionKeyId),
      tx.pure.u32(args.curve),
      tx.pure.u32(args.signatureAlgorithm),
      tx.pure.u64(args.dailyCapMicros),
      tx.pure.u64(args.coolDownMs),
      tx.pure.u64(args.unfreezeDelayMs),
      tx.pure.option('vector<u8>', args.rescueAddressBytes ? Array.from(args.rescueAddressBytes) : null),
      tx.pure.u64(args.stageDelayMs),
      ikaCoin,
      suiCoin,
    ],
  });
  return tx;
}

/** build a `panic` PTB. caller must be in the actuator list on-chain. */
export function buildPanicTx(args: { packageId: string; vaultObjectId: string }): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::panic`,
    arguments: [tx.object(args.vaultObjectId), tx.object('0x6')], // 0x6 = Sui Clock object
  });
  return tx;
}

/** build an `unfreeze` PTB. aborts on-chain if delay hasn't elapsed. */
export function buildUnfreezeTx(args: { packageId: string; vaultObjectId: string }): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::unfreeze`,
    arguments: [tx.object(args.vaultObjectId), tx.object('0x6')],
  });
  return tx;
}

/** build a `set_daily_cap` PTB. now requires Clock arg for staging-aware logic. */
export function buildSetDailyCapTx(args: {
  packageId: string;
  vaultObjectId: string;
  newCapMicros: bigint;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::set_daily_cap`,
    arguments: [
      tx.object(args.vaultObjectId),
      tx.pure.u64(args.newCapMicros),
      tx.object('0x6'),
    ],
  });
  return tx;
}

/** toggle the cap-increase staged delay opt-in. ON is immediate; OFF is staged. */
export function buildSetStageCapRaisesTx(args: {
  packageId: string;
  vaultObjectId: string;
  next: boolean;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::set_stage_cap_raises`,
    arguments: [
      tx.object(args.vaultObjectId),
      tx.pure.bool(args.next),
      tx.object('0x6'),
    ],
  });
  return tx;
}

/** change the stage-delay duration (ms). increase immediate; decrease staged when staging on. */
export function buildSetStageDelayMsTx(args: {
  packageId: string;
  vaultObjectId: string;
  newDelayMs: bigint;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::set_stage_delay_ms`,
    arguments: [
      tx.object(args.vaultObjectId),
      tx.pure.u64(args.newDelayMs),
      tx.object('0x6'),
    ],
  });
  return tx;
}

/** explicit commit of a pending cap raise once the delay has elapsed. */
export function buildCommitPendingCapTx(args: {
  packageId: string;
  vaultObjectId: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::commit_pending_cap`,
    arguments: [tx.object(args.vaultObjectId), tx.object('0x6')],
  });
  return tx;
}

/** explicit commit of a pending stage-off toggle. */
export function buildCommitPendingStageOffTx(args: {
  packageId: string;
  vaultObjectId: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::commit_pending_stage_off`,
    arguments: [tx.object(args.vaultObjectId), tx.object('0x6')],
  });
  return tx;
}

/** build a `request_unwrap` PTB. opens the staged exit window: after `stage_delay_ms`
 *  has elapsed, the same actuator (or any other actuator) may call `claim_unwrap` to
 *  retrieve the wrapped DWalletCap. Until then, the legitimate user can call `panic`
 *  to block the claim. */
export function buildRequestUnwrapTx(args: {
  packageId: string;
  vaultObjectId: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::request_unwrap`,
    arguments: [tx.object(args.vaultObjectId), tx.object('0x6')],
  });
  return tx;
}

/** build a `cancel_unwrap` PTB. idempotent; safe even while panicked. */
export function buildCancelUnwrapTx(args: {
  packageId: string;
  vaultObjectId: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::cancel_unwrap`,
    arguments: [tx.object(args.vaultObjectId), tx.object('0x6')],
  });
  return tx;
}

/** build a `claim_unwrap` PTB. Consumes the shared PolicyVault and returns the
 *  DWalletCap by value. Also transfers leftover presigns + ika + sui balances to the
 *  caller. The returned cap can be transferred to the caller in the same PTB (default)
 *  or composed with `chromatika_policy_v2::wrap_dwallet_cap` to migrate into a newer
 *  audited package version. Aborts if the unwrap delay has not elapsed, the unwrap was
 *  not requested, the caller is not an actuator, or the vault is panicked. */
export function buildClaimUnwrapTx(args: {
  packageId: string;
  vaultObjectId: string;
  /** address that receives the returned DWalletCap. Most often the same address that
   *  invoked `request_unwrap`. The function transfers the cap automatically in the same
   *  PTB so the caller doesn't need a follow-up tx. */
  recipientAddress: string;
}): Transaction {
  const tx = new Transaction();
  const cap = tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::claim_unwrap`,
    arguments: [tx.object(args.vaultObjectId), tx.object('0x6')],
  });
  tx.transferObjects([cap], tx.pure.address(args.recipientAddress));
  return tx;
}

/** build a `set_cool_down` PTB. */
export function buildSetCoolDownTx(args: {
  packageId: string;
  vaultObjectId: string;
  newCoolDownMs: bigint;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::set_cool_down`,
    arguments: [tx.object(args.vaultObjectId), tx.pure.u64(args.newCoolDownMs)],
  });
  return tx;
}

/** build a `set_rescue_address` PTB. pass null bytes to clear. */
export function buildSetRescueAddressTx(args: {
  packageId: string;
  vaultObjectId: string;
  rescueAddressBytes: Uint8Array | null;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::set_rescue_address`,
    arguments: [
      tx.object(args.vaultObjectId),
      tx.pure.option('vector<u8>', args.rescueAddressBytes ? Array.from(args.rescueAddressBytes) : null),
    ],
  });
  return tx;
}

/** build an `add_actuator` PTB. */
export function buildAddActuatorTx(args: {
  packageId: string;
  vaultObjectId: string;
  newActuator: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::add_actuator`,
    arguments: [tx.object(args.vaultObjectId), tx.pure.address(args.newActuator)],
  });
  return tx;
}

/** build a `remove_actuator` PTB. Move asserts at least one actuator must remain. */
export function buildRemoveActuatorTx(args: {
  packageId: string;
  vaultObjectId: string;
  target: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::remove_actuator`,
    arguments: [tx.object(args.vaultObjectId), tx.pure.address(args.target)],
  });
  return tx;
}

/** build an `add_ika_balance` PTB to top up the vault's IKA fee balance. */
export function buildAddIkaBalanceTx(args: {
  packageId: string;
  vaultObjectId: string;
  ikaCoinObjectId: string;
  amountMist: bigint;
}): Transaction {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.object(args.ikaCoinObjectId), [args.amountMist]);
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::add_ika_balance`,
    arguments: [tx.object(args.vaultObjectId), coin],
  });
  return tx;
}

/** build an `add_sui_balance` PTB. splits from gas. */
export function buildAddSuiBalanceTx(args: {
  packageId: string;
  vaultObjectId: string;
  amountMist: bigint;
}): Transaction {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [args.amountMist]);
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::add_sui_balance`,
    arguments: [tx.object(args.vaultObjectId), coin],
  });
  return tx;
}

/** build a `replenish_presign` PTB. */
export function buildReplenishPresignTx(args: {
  packageId: string;
  vaultObjectId: string;
  coordinatorObjectId: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::replenish_presign`,
    arguments: [tx.object(args.vaultObjectId), tx.object(args.coordinatorObjectId)],
  });
  return tx;
}

/**
 * build a `sign_with_policy` PTB. two move calls chained in one tx:
 *   1. `pop_presign(vault)` returns an `UnverifiedPresignCap` from the vault's pool
 *   2. `sign_with_policy(vault, coord, presign_cap, message, declaredValue, hash, msgSig, clock)`
 *      consumes the cap + emits a `PolicySigned` event with the new sign session id.
 *
 * aborts on-chain on cap breach / cool-down active / panicked / no presigns / not actuator.
 * the actual ika MPC sign is async; caller polls `getSignInParticularState` post-broadcast.
 */
export function buildSignWithPolicyTx(args: {
  packageId: string;
  vaultObjectId: string;
  coordinatorObjectId: string;
  message: Uint8Array;
  declaredValueMicros: bigint;
  hashScheme: number;
  messageCentralizedSignature: Uint8Array;
}): Transaction {
  const tx = new Transaction();
  const vaultArg = tx.object(args.vaultObjectId);
  const coordArg = tx.object(args.coordinatorObjectId);
  const popped = tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::pop_presign`,
    arguments: [vaultArg],
  });
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::sign_with_policy`,
    arguments: [
      vaultArg,
      coordArg,
      popped,
      tx.pure.vector('u8', Array.from(args.message)),
      tx.pure.u64(args.declaredValueMicros),
      tx.pure.u32(args.hashScheme),
      tx.pure.vector('u8', Array.from(args.messageCentralizedSignature)),
      tx.object('0x6'),
    ],
  });
  return tx;
}

/**
 * build a `rescue_sign` PTB. only valid while the vault is panicked AND the declared
 * recipient matches the pre-registered rescue address.
 *
 * chains `pop_presign_for_rescue` (panicked-allowed) -> `rescue_sign(presign_cap, ...)`.
 */
export function buildRescueSignTx(args: {
  packageId: string;
  vaultObjectId: string;
  coordinatorObjectId: string;
  message: Uint8Array;
  decodedRecipientBytes: Uint8Array;
  hashScheme: number;
  messageCentralizedSignature: Uint8Array;
}): Transaction {
  const tx = new Transaction();
  const vaultArg = tx.object(args.vaultObjectId);
  const coordArg = tx.object(args.coordinatorObjectId);
  const popped = tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::pop_presign_for_rescue`,
    arguments: [vaultArg],
  });
  tx.moveCall({
    target: `${args.packageId}::${MODULE_NAME}::rescue_sign`,
    arguments: [
      vaultArg,
      coordArg,
      popped,
      tx.pure.vector('u8', Array.from(args.message)),
      tx.pure.vector('u8', Array.from(args.decodedRecipientBytes)),
      tx.pure.u32(args.hashScheme),
      tx.pure.vector('u8', Array.from(args.messageCentralizedSignature)),
    ],
  });
  return tx;
}

// ─── error decoding helpers ──────────────────────────────────────────────────────

/** Move abort codes from `sign_gate.move` + `sign_gate_evm.move`. */
export const POLICY_VAULT_ABORT_CODES: Record<number, string> = {
  // sign_gate.move: 1-99
  1: 'caller is not in the actuator list',
  2: 'declared value would exceed the daily cap',
  3: 'cool-down still active; wait before next sign',
  4: 'vault is panicked; only rescue_sign is permitted',
  5: 'vault is not panicked; nothing to unfreeze',
  6: 'unfreeze delay has not elapsed yet',
  7: 'rescue destination does not match pre-registered rescue address',
  8: 'no rescue address is set on this vault',
  9: 'actuator already exists',
  10: 'actuator not found',
  11: 'presign pool is empty; replenish first',
  12: 'unfreeze delay below the protocol floor',
  13: 'no unwrap has been requested',
  14: 'unwrap delay still active; wait before claiming',
  15: 'an unwrap is already pending; cancel it before requesting again',
  // sign_gate_evm.move: 100-199
  100: 'malformed RLP: bad prefix byte',
  101: 'unsupported EVM tx type (only legacy + EIP-2930 + EIP-1559)',
  102: 'EVM tx bytes truncated before value field',
  103: 'EVM tx value exceeds u128 (16 bytes)',
  104: 'malformed RLP: expected string item, got list',
};

/** parse a Sui MoveAbort error message and return a friendly description if it matches. */
export function describePolicyVaultAbort(errorMessage: string): string | null {
  // Sui aborts surface as something like:
  // "MoveAbort(MoveLocation { module: ..., function: ..., instruction: 12 }, 4)"
  // or "MoveAbort(... , 5)" with nested commas inside the location braces. greedy `.*`
  // ensures we capture the FINAL `, <code>)` pair, not the first nested comma.
  const m = errorMessage.match(/MoveAbort\(.*,\s*(\d+)\)/);
  if (!m) return null;
  const code = parseInt(m[1]!, 10);
  return POLICY_VAULT_ABORT_CODES[code] ?? null;
}
