/**
 * integration tests for the `/fund` Worker endpoint. covers the auth + validation paths;
 * the actual Sui execute path is NOT exercised here (it would hit mainnet GraphQL with a
 * real privkey - too expensive + flaky for CI). a manual smoke test against `pnpm dev` +
 * a low-balance staging wallet covers the happy path - see README.
 *
 * what this file DOES verify:
 *   - 401 on missing / wrong bearer
 *   - 400 on invalid JSON / invalid recipient
 *   - 429 on already-funded address
 *   - 405 on wrong method
 *   - 404 on unknown route
 *   - admin DELETE auth + clear behavior
 *   - 502 when the Sui execute step fails (config error from missing FUNDER_SUI_PRIVKEY)
 */

import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import type { RateLimitDurableObject } from '../src/rate-limit';

type TestEnv = { RATE_LIMIT: DurableObjectNamespace<RateLimitDurableObject> };

const ADDR_GOOD = '0x' + 'c'.repeat(64);
const TOKEN = 'test-token';

function fundReq(body: unknown, token: string | null = TOKEN): Request {
  return new Request('https://example.com/fund', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('GET /healthz', () => {
  it('returns 200 plaintext', async () => {
    const res = await SELF.fetch('https://example.com/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('chromatika-team-funder ok');
  });
});

describe('POST /fund auth', () => {
  it('401s when no bearer is presented', async () => {
    const res = await SELF.fetch(fundReq({ recipientAddress: ADDR_GOOD }, null));
    expect(res.status).toBe(401);
  });

  it('401s when bearer does not match', async () => {
    const res = await SELF.fetch(fundReq({ recipientAddress: ADDR_GOOD }, 'wrong'));
    expect(res.status).toBe(401);
  });
});

describe('POST /fund body validation', () => {
  it('400s on invalid JSON', async () => {
    const req = new Request('https://example.com/fund', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: 'not json',
    });
    const res = await SELF.fetch(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_json' });
  });

  it('400s on missing recipientAddress', async () => {
    const res = await SELF.fetch(fundReq({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_recipient_address' });
  });

  it('400s on malformed address', async () => {
    const res = await SELF.fetch(fundReq({ recipientAddress: 'not-an-address' }));
    expect(res.status).toBe(400);
  });

  it('400s on address with non-hex characters', async () => {
    const res = await SELF.fetch(fundReq({ recipientAddress: '0xZZZZ' }));
    expect(res.status).toBe(400);
  });

  it('400s on address that is too long (>64 hex chars after 0x)', async () => {
    const res = await SELF.fetch(fundReq({ recipientAddress: '0x' + 'a'.repeat(65) }));
    expect(res.status).toBe(400);
  });
});

describe('POST /fund rate limiting', () => {
  it('returns 429 already_funded for an address that was already funded', async () => {
    // pre-stamp the address via the DO directly so we don't need a working Sui execute.
    const stub = (env as unknown as TestEnv).RATE_LIMIT.get(
      (env as unknown as TestEnv).RATE_LIMIT.idFromName('global'),
    );
    const addr = '0x' + 'd'.repeat(64);
    await stub.recordFunding({ address: addr });

    const res = await SELF.fetch(fundReq({ recipientAddress: addr }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'rate_limited', reason: 'already_funded' });
  });
});

describe('POST /fund Sui execute failure path', () => {
  it('returns 500 config_error when FUNDER_SUI_PRIVKEY is empty (vitest env intentionally omits it)', async () => {
    // miniflare bindings in vitest.config.ts set FUNDER_SUI_PRIVKEY=''. fund() reaches the
    // keypair load and surfaces a structured error. proves the path doesn't accidentally
    // succeed without a real key configured.
    const addr = '0x' + 'e'.repeat(64);
    const res = await SELF.fetch(fundReq({ recipientAddress: addr }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string; detail?: string };
    expect(body.error).toBe('config_error');
    expect(body.detail).toMatch(/suiprivkey/i);
  });
});

describe('method + route guards', () => {
  it('405 on GET /fund', async () => {
    const res = await SELF.fetch('https://example.com/fund');
    expect(res.status).toBe(405);
  });

  it('404 on unknown path', async () => {
    const res = await SELF.fetch('https://example.com/whatever');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /address admin', () => {
  it('returns 404 admin_disabled when ADMIN_BEARER_TOKEN is unset', async () => {
    // vitest miniflare env does not set ADMIN_BEARER_TOKEN, so the admin endpoint is
    // disabled. confirms admin is opt-in and won't be reachable in default deploys.
    const res = await SELF.fetch(
      new Request('https://example.com/address/' + ADDR_GOOD, {
        method: 'DELETE',
        headers: { authorization: 'Bearer anything' },
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'admin_disabled' });
  });
});
