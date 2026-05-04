/**
 * pure-data tests for the on-chain policy-vault parser. the end-to-end loader
 * (`readPolicyVaultSnapshot`) is harder to test without a live SDK; we hit the parser
 * directly with fixtures shaped like the Move struct fields a Sui SDK call would surface.
 */

import { describe, expect, it } from 'vitest';
import { parsePolicyVaultFields } from './policy-vault-read';

describe('parsePolicyVaultFields', () => {
  it('parses a healthy non-panicked vault with cap remaining', () => {
    const fields = {
      panicked: false,
      panic_at_ms: '0',
      unfreeze_delay_ms: '604800000', // 7d
      daily_cap_micros: '50000000', // $50
      spent_today_micros: '5000000', // $5
      cool_down_ms: '60000',
      last_sign_at_ms: '1700000000000',
      epoch_day: '19676',
      actuators: [
        '0x' + 'a'.repeat(64),
        '0x' + 'b'.repeat(64),
      ],
      rescue_address_bytes: { vec: [[1, 2, 3]] },
      ika_balance: { value: '12345' },
      sui_balance: { value: '67890' },
      presigns: ['p1', 'p2', 'p3'],
    };
    const snap = parsePolicyVaultFields(fields);
    expect(snap.panicked).toBe(false);
    expect(snap.panicAtMs).toBe(0);
    expect(snap.unfreezeDelayMs).toBe(604800000);
    expect(snap.unfreezeUnlocksAtMs).toBe(604800000); // panic_at + delay = 0 + 604800000
    expect(snap.dailyCapMicros).toBe('50000000');
    expect(snap.spentTodayMicros).toBe('5000000');
    expect(snap.coolDownMs).toBe(60000);
    expect(snap.lastSignAtMs).toBe(1700000000000);
    expect(snap.epochDay).toBe(19676);
    expect(snap.actuators).toHaveLength(2);
    expect(snap.hasRescueAddress).toBe(true);
    expect(snap.ikaBalance).toBe('12345');
    expect(snap.suiBalance).toBe('67890');
    expect(snap.presignsRemaining).toBe(3);
  });

  it('parses a panicked vault and computes unfreeze unlock time', () => {
    const fields = {
      panicked: true,
      panic_at_ms: '1700000000000',
      unfreeze_delay_ms: '60000',
      daily_cap_micros: '0',
      spent_today_micros: '0',
      cool_down_ms: '0',
      last_sign_at_ms: '0',
      epoch_day: '0',
      actuators: ['0x' + 'a'.repeat(64)],
      rescue_address_bytes: null,
      ika_balance: { fields: { value: '0' } }, // alternate shape
      sui_balance: { value: '0' },
      presigns: [],
    };
    const snap = parsePolicyVaultFields(fields);
    expect(snap.panicked).toBe(true);
    expect(snap.panicAtMs).toBe(1700000000000);
    expect(snap.unfreezeUnlocksAtMs).toBe(1700000000000 + 60000);
    expect(snap.hasRescueAddress).toBe(false);
    expect(snap.presignsRemaining).toBe(0);
    expect(snap.ikaBalance).toBe('0');
  });

  it('treats Option::None for rescue_address_bytes as no rescue', () => {
    const fields = {
      panicked: false,
      panic_at_ms: '0',
      unfreeze_delay_ms: '0',
      daily_cap_micros: '0',
      spent_today_micros: '0',
      cool_down_ms: '0',
      last_sign_at_ms: '0',
      epoch_day: '0',
      actuators: [],
      rescue_address_bytes: { vec: [] },
      ika_balance: { value: '0' },
      sui_balance: { value: '0' },
      presigns: [],
    };
    const snap = parsePolicyVaultFields(fields);
    expect(snap.hasRescueAddress).toBe(false);
  });

  it('falls back gracefully for missing balance fields', () => {
    const fields = {
      panicked: false,
      panic_at_ms: '0',
      unfreeze_delay_ms: '0',
      daily_cap_micros: '0',
      spent_today_micros: '0',
      cool_down_ms: '0',
      last_sign_at_ms: '0',
      epoch_day: '0',
      actuators: [],
      rescue_address_bytes: null,
      ika_balance: null,
      sui_balance: undefined,
      presigns: [],
    };
    const snap = parsePolicyVaultFields(fields);
    expect(snap.ikaBalance).toBe('0');
    expect(snap.suiBalance).toBe('0');
  });
});
