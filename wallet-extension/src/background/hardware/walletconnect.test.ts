import { describe, expect, it } from 'vitest';
import { isWcSessionPersisted } from '@/background/hardware/walletconnect';

describe('isWcSessionPersisted', () => {
  // Concrete fixture so each negative case can `{...valid, …}` instead of repeating fields.
  const valid = {
    vendor: 'walletconnect' as const,
    sessionTopic: 'a'.repeat(64),
    accountAddress: '11111111111111111111111111111111',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    pairedAtEpochMs: 1_700_000_000_000,
  };

  it('accepts a fully-shaped persisted record', () => {
    expect(isWcSessionPersisted(valid)).toBe(true);
  });

  it('rejects records with the wrong vendor discriminant (would route to the MWA path)', () => {
    expect(isWcSessionPersisted({ ...valid, vendor: 'mwa' })).toBe(false);
  });

  it('rejects records missing sessionTopic (would lose the relay routing key)', () => {
    const { sessionTopic: _drop, ...partial } = valid;
    expect(isWcSessionPersisted(partial)).toBe(false);
  });

  it('rejects records missing accountAddress', () => {
    const { accountAddress: _drop, ...partial } = valid;
    expect(isWcSessionPersisted(partial)).toBe(false);
  });

  it('rejects records missing chainId (frozen-at-pair-time means it must round-trip)', () => {
    const { chainId: _drop, ...partial } = valid;
    expect(isWcSessionPersisted(partial)).toBe(false);
  });

  it('rejects records where pairedAtEpochMs is a string', () => {
    expect(isWcSessionPersisted({ ...valid, pairedAtEpochMs: '1700000000000' })).toBe(false);
  });

  it('rejects records where sessionTopic is the wrong type', () => {
    expect(isWcSessionPersisted({ ...valid, sessionTopic: 123 })).toBe(false);
  });

  it('rejects null / undefined / primitives', () => {
    expect(isWcSessionPersisted(null)).toBe(false);
    expect(isWcSessionPersisted(undefined)).toBe(false);
    expect(isWcSessionPersisted('walletconnect')).toBe(false);
    expect(isWcSessionPersisted(42)).toBe(false);
  });
});
