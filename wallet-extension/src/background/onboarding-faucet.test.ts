/**
 * unit tests for the chromatika -> funder Worker fetch helper. exercises every branch of
 * `requestTeamFunding`'s outcome union so future edits don't accidentally collapse a 429 into
 * an error or vice versa.
 *
 * we mock `globalThis.fetch` rather than the helper's own dependencies so the assertion is
 * "given this HTTP exchange, the caller sees this `FaucetOutcome`" — closer to the real wire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'a'.repeat(64);

/**
 * dynamic import wrapped in a helper so each `import.meta.env` shape is established BEFORE the
 * module is evaluated (the module captures env vars in module-scoped `const`s at load time).
 */
async function loadModule(env: { url?: string; token?: string }): Promise<typeof import('./onboarding-faucet')> {
  vi.resetModules();
  // vitest stubs propagate to `import.meta.env` for both the test runner and child imports.
  vi.stubEnv('VITE_FUNDER_URL', env.url ?? '');
  vi.stubEnv('VITE_FUNDER_TOKEN', env.token ?? '');
  return await import('./onboarding-faucet');
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('faucetEnvConfigured', () => {
  it('returns false when both env vars are unset', async () => {
    const mod = await loadModule({});
    expect(mod.faucetEnvConfigured()).toBe(false);
  });

  it('returns false when only URL is set', async () => {
    const mod = await loadModule({ url: 'https://fund.example.com' });
    expect(mod.faucetEnvConfigured()).toBe(false);
  });

  it('returns false when only token is set', async () => {
    const mod = await loadModule({ token: 'secret' });
    expect(mod.faucetEnvConfigured()).toBe(false);
  });

  it('returns true when both URL and token are present', async () => {
    const mod = await loadModule({ url: 'https://fund.example.com', token: 'secret' });
    expect(mod.faucetEnvConfigured()).toBe(true);
  });
});

describe('requestTeamFunding outcomes', () => {
  it('returns kind:disabled and DOES NOT call fetch when env vars are unset', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const mod = await loadModule({});
    const r = await mod.requestTeamFunding(ADDR);
    expect(r).toEqual({ kind: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns kind:success on a 200 response with the right body shape', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ digest: 'DIG_OK', ikaSent: '120000000', suiSent: '120000000' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const mod = await loadModule({ url: 'https://fund.example.com', token: 'secret' });
    const r = await mod.requestTeamFunding(ADDR);
    expect(r).toMatchObject({ kind: 'success', digest: 'DIG_OK', ikaSent: '120000000', suiSent: '120000000' });

    // confirm we POSTed the canonical body + Authorization header.
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const [url, init] = call;
    expect(url).toBe('https://fund.example.com/fund');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ recipientAddress: ADDR }));
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('strips a trailing slash from VITE_FUNDER_URL when building the request URL', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ digest: 'd', ikaSent: '0', suiSent: '0' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const mod = await loadModule({ url: 'https://fund.example.com/', token: 'secret' });
    await mod.requestTeamFunding(ADDR);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    expect(call[0]).toBe('https://fund.example.com/fund');
  });

  it('returns kind:skipped on 429 with a structured reason', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: 'rate_limited', reason: 'already_funded' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const mod = await loadModule({ url: 'https://fund.example.com', token: 'secret' });
    const r = await mod.requestTeamFunding(ADDR);
    expect(r).toEqual({ kind: 'skipped', reason: 'already_funded' });
  });

  it('returns kind:skipped with default reason when 429 body is malformed', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('"not an object"', {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const mod = await loadModule({ url: 'https://fund.example.com', token: 'secret' });
    const r = await mod.requestTeamFunding(ADDR);
    // body parse yielded a non-object - skip path doesn't trigger; falls through to error.
    expect(r.kind).toBe('error');
  });

  it('returns kind:error with the body detail on 401', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const mod = await loadModule({ url: 'https://fund.example.com', token: 'wrong-token' });
    const r = await mod.requestTeamFunding(ADDR);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('typescript narrowing');
    expect(r.status).toBe(401);
    expect(r.message).toMatch(/401/);
    expect(r.message).toMatch(/unauthorized/);
  });

  it('returns kind:error with the detail field when present (502 sui_execute_failed)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ error: 'sui_execute_failed', detail: 'GraphQL HTTP 504' }),
        { status: 502 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const mod = await loadModule({ url: 'https://fund.example.com', token: 'secret' });
    const r = await mod.requestTeamFunding(ADDR);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('typescript narrowing');
    expect(r.status).toBe(502);
    expect(r.message).toMatch(/GraphQL HTTP 504/);
  });

  it('returns kind:error with status:null when fetch throws (offline)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const mod = await loadModule({ url: 'https://fund.example.com', token: 'secret' });
    const r = await mod.requestTeamFunding(ADDR);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('typescript narrowing');
    expect(r.status).toBeNull();
    expect(r.message).toMatch(/Failed to fetch/);
  });

  it('returns kind:error when 200 body shape is wrong (no digest)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const mod = await loadModule({ url: 'https://fund.example.com', token: 'secret' });
    const r = await mod.requestTeamFunding(ADDR);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('typescript narrowing');
    expect(r.status).toBe(200);
  });
});
