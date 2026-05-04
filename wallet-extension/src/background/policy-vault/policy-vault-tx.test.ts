/**
 * Sui PTB shape tests for the policy-vault transaction builders. we don't execute against a
 * live network here; we just assert that the builder produced a `Transaction` whose
 * serialized form contains the expected moveCall target string. the exact shape of
 * `Transaction.getData()` shifts across @mysten/sui versions, so we stringify the
 * built data structure and look for the target token, which is robust across shape changes.
 */

import { describe, expect, it } from 'vitest';
import {
  buildAddActuatorTx,
  buildOptInTx,
  buildPanicTx,
  buildRemoveActuatorTx,
  buildSetCoolDownTx,
  buildSetDailyCapTx,
  buildSetRescueAddressTx,
  buildUnfreezeTx,
  describePolicyVaultAbort,
  POLICY_VAULT_ABORT_CODES,
} from './policy-vault-tx';

const PKG = '0x' + 'a'.repeat(64);
const VAULT = '0x' + 'b'.repeat(64);
const COIN_IKA = '0x' + 'c'.repeat(64);
const COIN_SUI = '0x' + 'd'.repeat(64);
const NETWORK_KEY = '0x' + 'e'.repeat(64);
const ADDR = '0x' + '1'.repeat(64);
const CAP = '0x' + '2'.repeat(64);

/**
 * assert that the transaction's serialized data references a Move function. Mysten v2.13
 * splits target into `package` / `module` / `function` fields rather than a single string,
 * so we serialize JSON and look for both `"<module>"` and `"<function>"` substrings.
 * optionally also asserts the package id appears.
 */
function txContainsMoveCall(
  tx: ReturnType<typeof buildPanicTx>,
  args: { module: string; function: string; packageId?: string },
): boolean {
  const anyTx = tx as unknown as { getData?: () => unknown };
  const data = typeof anyTx.getData === 'function' ? anyTx.getData() : anyTx;
  const json = JSON.stringify(data);
  if (!json.includes(`"${args.module}"`)) return false;
  if (!json.includes(`"${args.function}"`)) return false;
  if (args.packageId && !json.includes(args.packageId)) return false;
  return true;
}

describe('PTB targets', () => {
  it('buildPanicTx targets sign_gate::panic', () => {
    const tx = buildPanicTx({ packageId: PKG, vaultObjectId: VAULT });
    expect(txContainsMoveCall(tx, { module: 'sign_gate', function: 'panic' })).toBe(true);
  });

  it('buildUnfreezeTx targets sign_gate::unfreeze', () => {
    const tx = buildUnfreezeTx({ packageId: PKG, vaultObjectId: VAULT });
    expect(txContainsMoveCall(tx, { module: 'sign_gate', function: 'unfreeze' })).toBe(true);
  });

  it('buildSetDailyCapTx targets sign_gate::set_daily_cap', () => {
    const tx = buildSetDailyCapTx({
      packageId: PKG,
      vaultObjectId: VAULT,
      newCapMicros: 50_000_000n,
    });
    expect(txContainsMoveCall(tx, { module: 'sign_gate', function: 'set_daily_cap' })).toBe(true);
  });

  it('buildSetCoolDownTx targets sign_gate::set_cool_down', () => {
    const tx = buildSetCoolDownTx({
      packageId: PKG,
      vaultObjectId: VAULT,
      newCoolDownMs: 60_000n,
    });
    expect(txContainsMoveCall(tx, { module: 'sign_gate', function: 'set_cool_down' })).toBe(true);
  });

  it('buildSetRescueAddressTx targets sign_gate::set_rescue_address', () => {
    const tx = buildSetRescueAddressTx({
      packageId: PKG,
      vaultObjectId: VAULT,
      rescueAddressBytes: new Uint8Array([1, 2, 3]),
    });
    expect(
      txContainsMoveCall(tx, { module: 'sign_gate', function: 'set_rescue_address' }),
    ).toBe(true);
  });

  it('buildAddActuatorTx targets sign_gate::add_actuator', () => {
    const tx = buildAddActuatorTx({ packageId: PKG, vaultObjectId: VAULT, newActuator: ADDR });
    expect(txContainsMoveCall(tx, { module: 'sign_gate', function: 'add_actuator' })).toBe(true);
  });

  it('buildRemoveActuatorTx targets sign_gate::remove_actuator', () => {
    const tx = buildRemoveActuatorTx({ packageId: PKG, vaultObjectId: VAULT, target: ADDR });
    expect(
      txContainsMoveCall(tx, { module: 'sign_gate', function: 'remove_actuator' }),
    ).toBe(true);
  });

  it('buildOptInTx final command targets sign_gate::wrap_dwallet_cap', () => {
    const tx = buildOptInTx({
      packageId: PKG,
      dwalletCapObjectId: CAP,
      dwalletNetworkEncryptionKeyId: NETWORK_KEY,
      curve: 0,
      signatureAlgorithm: 0,
      dailyCapMicros: 50_000_000n,
      coolDownMs: 60_000n,
      unfreezeDelayMs: 604_800_000n,
      rescueAddressBytes: null,
      stageDelayMs: 86_400_000n,
      ikaCoinObjectId: COIN_IKA,
      suiCoinObjectId: COIN_SUI,
      initialIkaMist: 10_000_000n,
      initialSuiMist: 10_000_000n,
    });
    expect(
      txContainsMoveCall(tx, { module: 'sign_gate', function: 'wrap_dwallet_cap' }),
    ).toBe(true);
  });

  it('buildOptInTx without explicit suiCoinObjectId still targets wrap_dwallet_cap', () => {
    const tx = buildOptInTx({
      packageId: PKG,
      dwalletCapObjectId: CAP,
      dwalletNetworkEncryptionKeyId: NETWORK_KEY,
      curve: 0,
      signatureAlgorithm: 0,
      dailyCapMicros: 0n,
      coolDownMs: 0n,
      unfreezeDelayMs: 60_000n,
      rescueAddressBytes: new Uint8Array([0x30, 0x78]),
      stageDelayMs: 86_400_000n,
      ikaCoinObjectId: COIN_IKA,
      suiCoinObjectId: null,
      initialIkaMist: 1_000_000n,
      initialSuiMist: 1_000_000n,
    });
    expect(
      txContainsMoveCall(tx, { module: 'sign_gate', function: 'wrap_dwallet_cap' }),
    ).toBe(true);
  });
});

describe('describePolicyVaultAbort', () => {
  it('decodes a Move abort code into a friendly description', () => {
    const msg =
      'MoveAbort(MoveLocation { module: ModuleId { address: 0xa, name: Identifier("sign_gate") }, function: 5, instruction: 12 }, 4)';
    expect(describePolicyVaultAbort(msg)).toBe(POLICY_VAULT_ABORT_CODES[4]);
  });

  it('decodes a simple form without nested commas', () => {
    const msg = 'MoveAbort(_, 7)';
    expect(describePolicyVaultAbort(msg)).toBe(POLICY_VAULT_ABORT_CODES[7]);
  });

  it('returns null for non-MoveAbort error messages', () => {
    expect(describePolicyVaultAbort('insufficient gas')).toBeNull();
    expect(describePolicyVaultAbort('')).toBeNull();
  });

  it('returns null for unknown abort codes', () => {
    const msg = 'MoveAbort(... , 9999)';
    expect(describePolicyVaultAbort(msg)).toBeNull();
  });

  it('covers all 12 declared abort codes with friendly messages', () => {
    for (let i = 1; i <= 12; i++) {
      expect(typeof POLICY_VAULT_ABORT_CODES[i]).toBe('string');
    }
  });
});
