/**
 * Unit tests for the Sui tx classifier. Pure function over MoveCall summaries.
 */

import { describe, it, expect } from 'vitest';
import {
  classifySuiTx,
  KNOWN_SUI_SWAP_MODULES,
} from './sui-classifier';
import type { IndexedTx } from '@/background/services/activity-index';

function makeRow(): IndexedTx {
  return {
    key: 'sui:vault1:0xdigest',
    vaultId: 'vault1',
    chain: 'sui',
    digest: '0xdigest',
    perspectiveAddress: '0xowner',
    counterparty: '0xrecipient',
    position: '12345',
    timestampMs: 1234567890,
    symbol: 'SUI',
    amountRaw: '1000000000',
    source: 'mysten-graphql',
    status: 'success',
  };
}

describe('classifySuiTx', () => {
  it('returns transfer when no moveCalls (pure splitCoins + transferObjects)', () => {
    const r = classifySuiTx(makeRow(), { moveCalls: [] });
    expect(r.kind).toBe('transfer');
  });

  it('returns transfer when moveCalls hint is missing entirely', () => {
    const r = classifySuiTx(makeRow());
    expect(r.kind).toBe('transfer');
  });

  it('returns swap when a MoveCall targets a known DEX module (Cetus pool)', () => {
    const cetusPool = [...KNOWN_SUI_SWAP_MODULES][0]!; // first entry is Cetus pool
    const [pkg, mod] = cetusPool.split('::');
    const r = classifySuiTx(makeRow(), {
      moveCalls: [{ package: pkg!, module: mod!, functionName: 'swap' }],
    });
    expect(r.kind).toBe('swap');
  });

  it('returns stakeDelegate when MoveCall function is request_add_stake (Sui native or ika)', () => {
    const r = classifySuiTx(makeRow(), {
      moveCalls: [
        { package: '0x3', module: 'sui_system', functionName: 'request_add_stake' },
      ],
    });
    expect(r.kind).toBe('stakeDelegate');
  });

  it('returns stakeWithdraw when MoveCall function is request_withdraw_stake', () => {
    const r = classifySuiTx(makeRow(), {
      moveCalls: [
        { package: '0x3', module: 'sui_system', functionName: 'request_withdraw_stake' },
      ],
    });
    expect(r.kind).toBe('stakeWithdraw');
  });

  it('returns stakeDelegate for ika stake functions on arbitrary package (function-name fallback)', () => {
    const r = classifySuiTx(makeRow(), {
      moveCalls: [
        { package: '0xikadeploypkg', module: 'ika_system', functionName: 'request_add_stake_non_entry' },
      ],
    });
    expect(r.kind).toBe('stakeDelegate');
  });

  it('returns smartContractCall when MoveCall targets unknown package + module', () => {
    const r = classifySuiTx(makeRow(), {
      moveCalls: [
        { package: '0xunknownpkg', module: 'some_module', functionName: 'do_thing' },
      ],
    });
    expect(r.kind).toBe('smartContractCall');
  });

  it('prefers swap classification when both swap and non-swap MoveCalls are present', () => {
    const cetusPool = [...KNOWN_SUI_SWAP_MODULES][0]!;
    const [pkg, mod] = cetusPool.split('::');
    const r = classifySuiTx(makeRow(), {
      moveCalls: [
        { package: '0xunknown', module: 'a', functionName: 'b' },
        { package: pkg!, module: mod!, functionName: 'swap_a2b' },
      ],
    });
    // unknown moveCall doesn't terminate the loop; the swap moveCall later in the list
    // hits the swap-module allowlist and returns. fallback `smartContractCall` only
    // fires when NO call matches anything.
    expect(r.kind).toBe('swap');
  });
});
