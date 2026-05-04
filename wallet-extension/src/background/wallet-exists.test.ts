import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { walletExists } from '@/background/wallet-service';

const VAULT_KEY = 'chromatika_vault_v2';

describe('walletExists', () => {
  const origChrome = globalThis.chrome;

  beforeEach(() => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn((_keys: string[], cb: (r: Record<string, unknown>) => void) => {
            cb({});
          }),
        },
      },
    });
  });

  afterEach(() => {
    if (origChrome !== undefined) {
      vi.stubGlobal('chrome', origChrome);
    } else {
      // @ts-expect-error cleanup
      delete globalThis.chrome;
    }
    vi.unstubAllGlobals();
  });

  it('resolves false when vault blob is absent', async () => {
    await expect(walletExists()).resolves.toBe(false);
  });

  it('resolves true when vault blob is present', async () => {
    const get = vi.fn((_keys: string[], cb: (r: Record<string, unknown>) => void) => {
      cb({ [VAULT_KEY]: 'encrypted' });
    });
    vi.stubGlobal('chrome', {
      storage: {
        local: { get },
      },
    });
    await expect(walletExists()).resolves.toBe(true);
  });
});
