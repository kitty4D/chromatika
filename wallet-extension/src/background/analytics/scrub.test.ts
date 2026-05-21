import { describe, it, expect } from 'vitest';
import { scrubString, scrubBreadcrumbData, scrubEvent, scrubBreadcrumb } from './scrub';

describe('scrubString', () => {
  it('redacts EVM addresses (0x + 40 hex chars)', () => {
    const addr = '0xAbCd1234567890abcdef1234567890ABCDEF1234';
    expect(scrubString(`sent to ${addr}`)).toBe('sent to [REDACTED]');
  });

  it('redacts Sui object IDs (0x + 64 hex chars)', () => {
    const id = '0x' + 'a'.repeat(64);
    expect(scrubString(id)).toBe('[REDACTED]');
  });

  it('redacts base58 Solana addresses (32+ chars)', () => {
    // typical solana pubkey is 44 base58 chars
    const pubkey = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
    expect(scrubString(`payer: ${pubkey}`)).toBe('payer: [REDACTED]');
  });

  it('redacts suiprivkey-prefixed strings', () => {
    expect(scrubString('suiprivkeyABCDEFGHIJKLMNOP')).toBe('[REDACTED]');
  });

  it('redacts solprivkey-prefixed strings', () => {
    expect(scrubString('solprivkey1234567890ABCDEF')).toBe('[REDACTED]');
  });

  it('redacts URLs containing api keys', () => {
    const url = 'https://api.coingecko.com/api/v3/coins?x-cg-api-key=SECRETKEY123';
    const result = scrubString(`fetching ${url}`);
    expect(result).toBe('fetching [REDACTED_URL]');
  });

  it('leaves short normal strings alone', () => {
    expect(scrubString('hello world')).toBe('hello world');
    expect(scrubString('0x1234')).toBe('0x1234'); // too short to be an address
    expect(scrubString('transfer failed')).toBe('transfer failed');
  });

  it('handles null gracefully', () => {
    expect(scrubString(null)).toBe('');
  });

  it('handles undefined gracefully', () => {
    expect(scrubString(undefined)).toBe('');
  });

  it('converts non-string values to string before scrubbing', () => {
    expect(scrubString(42)).toBe('42');
    expect(scrubString(true)).toBe('true');
  });
});

describe('scrubBreadcrumbData', () => {
  it('redacts values for sensitive field names', () => {
    const data = {
      password: 'hunter2',
      mnemonic: 'abandon abandon abandon',
      seed: 'deadbeef',
      privkey: 'secretstuff',
      privatekey: 'moresecret',
      secret: 'ssshh',
      secretkey: 'alsosecret',
    };
    const result = scrubBreadcrumbData(data);
    for (const key of Object.keys(data)) {
      expect(result[key]).toBe('[REDACTED]');
    }
  });

  it('leaves non-sensitive string fields after scrubString pass', () => {
    const data = {
      action: 'sendTx',
      status: 'ok',
    };
    const result = scrubBreadcrumbData(data);
    expect(result['action']).toBe('sendTx');
    expect(result['status']).toBe('ok');
  });

  it('scrubs wallet addresses found in non-sensitive string fields', () => {
    const addr = '0xAbCd1234567890abcdef1234567890ABCDEF1234';
    const data = { message: `error sending to ${addr}` };
    const result = scrubBreadcrumbData(data);
    expect(result['message']).toBe('error sending to [REDACTED]');
  });

  it('passes through non-string non-sensitive values unchanged', () => {
    const data = { retries: 3, success: false };
    const result = scrubBreadcrumbData(data);
    expect(result['retries']).toBe(3);
    expect(result['success']).toBe(false);
  });

  it('returns empty object for undefined input', () => {
    expect(scrubBreadcrumbData(undefined)).toEqual({});
  });

  it('is case-insensitive for sensitive field names', () => {
    const data = { Password: 'oops', MNEMONIC: 'words here' };
    const result = scrubBreadcrumbData(data);
    expect(result['Password']).toBe('[REDACTED]');
    expect(result['MNEMONIC']).toBe('[REDACTED]');
  });
});

describe('scrubEvent', () => {
  it('redacts addresses anywhere in the event tree', () => {
    const addr = '0x' + 'b'.repeat(40);
    const event = {
      message: `failed for ${addr}`,
      extra: { to: addr },
    };
    const result = scrubEvent(event) as typeof event;
    expect(result.message).toBe('failed for [REDACTED]');
    expect(result.extra.to).toBe('[REDACTED]');
  });

  it('returns the original event if JSON serialization fails', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    // should not throw
    const result = scrubEvent(circular);
    expect(result).toBe(circular);
  });
});

describe('scrubBreadcrumb', () => {
  it('scrubs the data bag of a breadcrumb', () => {
    const bc = {
      category: 'send',
      level: 'info',
      data: { password: 'oops', action: 'submit' },
    };
    const result = scrubBreadcrumb(bc) as typeof bc;
    expect(result.data.password).toBe('[REDACTED]');
    expect(result.data.action).toBe('submit');
    expect(result.category).toBe('send');
  });

  it('passes through breadcrumbs with no data field', () => {
    const bc = { category: 'navigation', message: 'clicked send' };
    expect(scrubBreadcrumb(bc)).toEqual(bc);
  });

  it('returns non-object breadcrumbs as-is', () => {
    expect(scrubBreadcrumb(null)).toBe(null);
    expect(scrubBreadcrumb('raw string')).toBe('raw string');
  });
});
