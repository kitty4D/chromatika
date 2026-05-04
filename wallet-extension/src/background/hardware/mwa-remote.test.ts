import { describe, expect, it } from 'vitest';
import {
  MWA_REMOTE_HOST_AUTHORITY,
  buildRemoteMwaConfig,
  isMwaRemotePersisted,
} from '@/background/hardware/mwa-remote';

describe('MWA_REMOTE_HOST_AUTHORITY', () => {
  it('is the host-authority shape (no scheme, no path)', () => {
    // Solana Mobile does not ship a public reflector, we host our own under `/reflector`
    // (Cloudflare Workers + Durable Objects). the constant is a placeholder until the
    // operator runs `wrangler deploy` and pins the resulting `*.workers.dev` (or custom
    // domain) here. whatever value is set must NOT include a scheme or path: the upstream
    // `startRemoteScenario` constructs `wss://<host>/reflect` itself, shipping `wss://...`
    // here yields `wss://wss://...` and rejects.
    expect(MWA_REMOTE_HOST_AUTHORITY).not.toMatch(/^wss?:\/\//);
    expect(MWA_REMOTE_HOST_AUTHORITY).not.toContain('/');
    expect(MWA_REMOTE_HOST_AUTHORITY.length).toBeGreaterThan(0);
  });
});

describe('buildRemoteMwaConfig', () => {
  it('defaults to the canonical reflector host when no overrides given', () => {
    const cfg = buildRemoteMwaConfig();
    expect(cfg.remoteHostAuthority).toBe(MWA_REMOTE_HOST_AUTHORITY);
    // No baseUri spread when not requested - keep the object minimal so the
    // upstream lib applies its own defaults.
    expect('baseUri' in cfg).toBe(false);
  });

  it('honors a hostAuthority override (for tests / private reflector)', () => {
    const cfg = buildRemoteMwaConfig({ hostAuthority: 'reflect.example.test' });
    expect(cfg.remoteHostAuthority).toBe('reflect.example.test');
  });

  it('forwards baseUri only when explicitly provided', () => {
    const cfg = buildRemoteMwaConfig({ baseUri: '/custom-path' });
    expect(cfg.remoteHostAuthority).toBe(MWA_REMOTE_HOST_AUTHORITY);
    expect(cfg.baseUri).toBe('/custom-path');
  });

  it('returns a fresh object each call (no aliasing footgun)', () => {
    const a = buildRemoteMwaConfig();
    const b = buildRemoteMwaConfig();
    expect(a).not.toBe(b);
  });
});

describe('isMwaRemotePersisted', () => {
  const valid = {
    transport: 'remote' as const,
    authToken: 'opaque-token-blob',
    address: '11111111111111111111111111111111',
    reflectorHost: MWA_REMOTE_HOST_AUTHORITY,
    pairedAtEpochMs: 1_700_000_000_000,
  };

  it('accepts a fully-shaped persisted record', () => {
    expect(isMwaRemotePersisted(valid)).toBe(true);
  });

  it('rejects local-transport records (different shape, different storage)', () => {
    expect(isMwaRemotePersisted({ ...valid, transport: 'local' })).toBe(false);
  });

  it('rejects records missing authToken', () => {
    const { authToken: _drop, ...partial } = valid;
    expect(isMwaRemotePersisted(partial)).toBe(false);
  });

  it('rejects records where authToken is the wrong type', () => {
    expect(isMwaRemotePersisted({ ...valid, authToken: 123 })).toBe(false);
  });

  it('rejects records missing reflectorHost (would lose pinning on read)', () => {
    const { reflectorHost: _drop, ...partial } = valid;
    expect(isMwaRemotePersisted(partial)).toBe(false);
  });

  it('rejects records where pairedAtEpochMs is a string', () => {
    expect(isMwaRemotePersisted({ ...valid, pairedAtEpochMs: '1700000000000' })).toBe(false);
  });

  it('rejects null / undefined / primitives', () => {
    expect(isMwaRemotePersisted(null)).toBe(false);
    expect(isMwaRemotePersisted(undefined)).toBe(false);
    expect(isMwaRemotePersisted('remote')).toBe(false);
    expect(isMwaRemotePersisted(42)).toBe(false);
  });
});
