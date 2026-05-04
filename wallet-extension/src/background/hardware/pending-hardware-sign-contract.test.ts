import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  toHardwareSignMeta,
  validateHardwareSignRequestPayload,
} from '@/background/hardware/pending-hardware-sign-contract';
import type { PendingHardwareSign } from '@/background/hardware/types';
import {
  enqueueHardwareSign,
  getPendingHardwareSignMeta,
} from '@/background/hardware/pending-queue';

describe('validateHardwareSignRequestPayload', () => {
  it('accepts evm message with hex (no 0x)', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'ledger',
        chain: 'evm',
        derivationPath: "m/44'/60'/0'/0/0",
        payloadHex: 'deadbeef',
        kind: 'message',
      }),
    ).not.toThrow();
  });

  it('rejects evm message with 0x prefix', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'ledger',
        chain: 'evm',
        derivationPath: "m/44'/60'/0'/0/0",
        payloadHex: '0xab',
        kind: 'message',
      }),
    ).toThrow(/must not include 0x/);
  });

  it('accepts evm typedData with concatenated 0x domain + struct (ethers style)', () => {
    const domain = `0x${'a'.repeat(64)}`;
    const struct = `0x${'b'.repeat(64)}`;
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'ledger',
        chain: 'evm',
        derivationPath: "m/44'/60'/0'/0/0",
        payloadHex: domain + struct,
        kind: 'typedData',
      }),
    ).not.toThrow();
  });

  it('accepts sui suiTx with ed25519PublicKeyB64', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'ledger',
        chain: 'sui',
        derivationPath: "m/44'/784'/0'/0/0'",
        payloadHex: '00ab',
        kind: 'suiTx',
        ed25519PublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      }),
    ).not.toThrow();
  });

  it('rejects sui suiTx without ed25519PublicKeyB64', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'ledger',
        chain: 'sui',
        derivationPath: "m/44'/784'/0'/0/0'",
        payloadHex: '00ab',
        kind: 'suiTx',
      }),
    ).toThrow(/ed25519PublicKeyB64/);
  });

  it('accepts solana solanaTx', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'ledger',
        chain: 'solana',
        derivationPath: "m/44'/501'/0'/0'",
        payloadHex: '01ff',
        kind: 'solanaTx',
      }),
    ).not.toThrow();
  });

  it('accepts solana solanaOffchain', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'ledger',
        chain: 'solana',
        derivationPath: "m/44'/501'/0'/0'",
        payloadHex: 'aa',
        kind: 'solanaOffchain',
      }),
    ).not.toThrow();
  });

  it('rejects solana with wrong kind', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'ledger',
        chain: 'solana',
        derivationPath: "m/44'/501'/0'/0'",
        payloadHex: 'ab',
        kind: 'message',
      }),
    ).toThrow(/solanaTx/);
  });

  it('accepts bitcoin btcTx with PSBT hex', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'ledger',
        chain: 'bitcoin',
        derivationPath: "m/84'/0'/0'/0/0",
        payloadHex: 'deadbeef01020304',
        kind: 'btcTx',
      }),
    ).not.toThrow();
  });

  it('rejects bitcoin with wrong kind', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'ledger',
        chain: 'bitcoin',
        derivationPath: "m/84'/0'/0'/0/0",
        payloadHex: 'ab',
        kind: 'message',
      }),
    ).toThrow(/btcTx/);
  });

  it('accepts mwa solanaTx', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'mwa',
        chain: 'solana',
        derivationPath: "m/44'/501'/0'/0'",
        payloadHex: '01ff',
        kind: 'solanaTx',
      }),
    ).not.toThrow();
  });

  it('accepts mwa solanaOffchain', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'mwa',
        chain: 'solana',
        derivationPath: "m/44'/501'/0'/0'",
        payloadHex: 'aa',
        kind: 'solanaOffchain',
      }),
    ).not.toThrow();
  });

  it('rejects mwa on non-solana chain', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'mwa',
        chain: 'evm',
        derivationPath: "m/44'/60'/0'/0/0",
        payloadHex: 'aa',
        kind: 'message',
      }),
    ).toThrow(/solana/);
  });

  it('rejects mwa with non-solana kind', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'mwa',
        chain: 'solana',
        derivationPath: "m/44'/501'/0'/0'",
        payloadHex: 'aa',
        kind: 'message',
      }),
    ).toThrow(/solanaTx/);
  });

  it('accepts walletconnect solanaTx with all WC fields', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'walletconnect',
        chain: 'solana',
        derivationPath: 'wc:solana',
        payloadHex: '01ff',
        kind: 'solanaTx',
        wcSessionTopic: 'a'.repeat(64),
        wcChainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        wcAccountAddress: '11111111111111111111111111111111',
      }),
    ).not.toThrow();
  });

  it('accepts walletconnect solanaOffchain with all WC fields', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'walletconnect',
        chain: 'solana',
        derivationPath: 'wc:solana',
        payloadHex: 'aa',
        kind: 'solanaOffchain',
        wcSessionTopic: 'a'.repeat(64),
        wcChainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        wcAccountAddress: '11111111111111111111111111111111',
      }),
    ).not.toThrow();
  });

  it('rejects walletconnect on non-solana chain', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'walletconnect',
        chain: 'evm',
        derivationPath: 'wc:solana',
        payloadHex: 'aa',
        kind: 'message',
        wcSessionTopic: 'a'.repeat(64),
        wcChainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        wcAccountAddress: '11111111111111111111111111111111',
      }),
    ).toThrow(/solana/);
  });

  it('rejects walletconnect missing wcSessionTopic (cannot route the sign)', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'walletconnect',
        chain: 'solana',
        derivationPath: 'wc:solana',
        payloadHex: 'aa',
        kind: 'solanaOffchain',
        wcChainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        wcAccountAddress: '11111111111111111111111111111111',
      }),
    ).toThrow(/wcSessionTopic/);
  });

  it('rejects walletconnect missing wcChainId', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'walletconnect',
        chain: 'solana',
        derivationPath: 'wc:solana',
        payloadHex: 'aa',
        kind: 'solanaOffchain',
        wcSessionTopic: 'a'.repeat(64),
        wcAccountAddress: '11111111111111111111111111111111',
      }),
    ).toThrow(/wcChainId/);
  });

  it('rejects walletconnect missing wcAccountAddress', () => {
    expect(() =>
      validateHardwareSignRequestPayload({
        vendor: 'walletconnect',
        chain: 'solana',
        derivationPath: 'wc:solana',
        payloadHex: 'aa',
        kind: 'solanaOffchain',
        wcSessionTopic: 'a'.repeat(64),
        wcChainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      }),
    ).toThrow(/wcAccountAddress/);
  });
});

describe('toHardwareSignMeta', () => {
  it('drops resolve and reject', () => {
    const entry = {
      id: 'x',
      vendor: 'ledger' as const,
      chain: 'evm' as const,
      derivationPath: "m/44'/60'/0'/0/0",
      payloadHex: 'aa',
      kind: 'message' as const,
      resolve: vi.fn(),
      reject: vi.fn(),
    } satisfies PendingHardwareSign;
    const meta = toHardwareSignMeta(entry);
    expect(meta).toEqual({
      id: 'x',
      vendor: 'ledger',
      chain: 'evm',
      derivationPath: "m/44'/60'/0'/0/0",
      payloadHex: 'aa',
      kind: 'message',
    });
    expect('resolve' in meta).toBe(false);
    expect('reject' in meta).toBe(false);
  });
});

describe('enqueueHardwareSign + getPendingHardwareSignMeta', () => {
  beforeAll(() => {
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
      },
      windows: {
        getLastFocused: vi.fn().mockResolvedValue({ left: 0, top: 0, width: 1200 }),
        create: vi.fn().mockResolvedValue({ id: 1 }),
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('stores meta without resolve/reject handlers', async () => {
    const createMock = chrome.windows.create as unknown as ReturnType<typeof vi.fn>;
    void enqueueHardwareSign({
      vendor: 'ledger',
      chain: 'evm',
      derivationPath: "m/44'/60'/0'/0/0",
      payloadHex: 'cafe',
      kind: 'message',
    });
    await vi.waitFor(() => expect(createMock).toHaveBeenCalled());
    const url = String(createMock.mock.calls[0]?.[0]?.url ?? '');
    const idMatch = url.match(/hwsign=([^&]+)/);
    expect(idMatch).toBeTruthy();
    const id = decodeURIComponent(idMatch![1]);
    expect(id.startsWith('hsign-')).toBe(true);
    const meta = getPendingHardwareSignMeta(id);
    expect(meta).not.toBeNull();
    expect(meta).toMatchObject({
      id,
      vendor: 'ledger',
      chain: 'evm',
      kind: 'message',
      payloadHex: 'cafe',
    });
    expect(meta && 'resolve' in meta).toBe(false);
    expect(meta && 'reject' in meta).toBe(false);
  });
});
