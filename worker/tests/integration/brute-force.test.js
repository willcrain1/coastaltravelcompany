/**
 * Integration: brute-force rate limiting exercised through handleRequest().
 *
 * Each auth endpoint receives real failed requests via the full router stack
 * with no mocks on the rate-limiting path. Any future auth route added without
 * wiring into brute-force.js will be caught here.
 *
 * Three surfaces:
 *  POST /auth/login         — per-email (5) and per-IP (20) hard lockouts → 429
 *  POST /auth/reset-request — per-email (3) silent limit (always 200, anti-enumeration)
 *  POST /token              — per-IP (10) NAS-failure counter → 429
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleRequest } from '../../src/router.js';
import { makeKv, makeEnv, req, adminToken, ORIGIN } from './helpers.js';

const IP = '10.0.0.1';
let env;

beforeEach(() => {
  env = makeEnv(makeKv());
});

function post(path, body, ip = IP) {
  return handleRequest(
    req('POST', path, { body, extraHeaders: { 'CF-Connecting-IP': ip } }),
    env,
  );
}

// ── POST /auth/login — per-email ──────────────────────────────────────────────

describe('POST /auth/login brute-force — per-email', () => {
  const EMAIL = 'victim@t.com';

  it('returns 429 on the 6th failed attempt for the same email', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post('/auth/login', { email: EMAIL, password: 'wrong' })).status).toBe(401);
    }
    const r = await post('/auth/login', { email: EMAIL, password: 'wrong' });
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('900');
    expect((await r.json()).error).toMatch(/Too many failed login attempts/);
  });

  it('clears counters on successful login so the account becomes accessible again', async () => {
    await handleRequest(req('POST', '/auth/register', { body: { email: EMAIL, password: 'password123' } }), env);
    const kv = env.KV;
    const verifyKey = [...kv._store.keys()].find(k => k.startsWith('verify:'));
    await handleRequest(req('GET', `/auth/verify?token=${verifyKey.replace('verify:', '')}`), env);

    // Accumulate 3 failures — below threshold
    for (let i = 0; i < 3; i++) {
      await post('/auth/login', { email: EMAIL, password: 'wrong' });
    }
    expect(await kv.get(`brute:email:${EMAIL}`)).toBe('3');

    // Successful login clears the counter
    const r = await post('/auth/login', { email: EMAIL, password: 'password123' });
    expect(r.status).toBe(200);
    expect(await kv.get(`brute:email:${EMAIL}`)).toBeNull();
  });
});

// ── POST /auth/login — per-IP ─────────────────────────────────────────────────

describe('POST /auth/login brute-force — per-IP', () => {
  it('returns 429 on the 21st failed attempt from the same IP across different emails', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await post('/auth/login', { email: `u${i}@t.com`, password: 'wrong' })).status).toBe(401);
    }
    const r = await post('/auth/login', { email: 'new@t.com', password: 'wrong' });
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('900');
    expect((await r.json()).error).toMatch(/your network/);
  });
});

// ── POST /auth/reset-request — silent limit (anti-enumeration) ────────────────

describe('POST /auth/reset-request brute-force', () => {
  const EMAIL = 'reset@t.com';

  it('always returns { ok: true } but KV proves the limit activated after 3 requests', async () => {
    // Requests 1–3: under limit, email would be sent (no RESEND_API_KEY in env → silently skipped)
    // Request 4:   over limit, email suppressed — HTTP response is still 200 to prevent enumeration
    for (let i = 0; i < 4; i++) {
      const r = await post('/auth/reset-request', { email: EMAIL });
      expect(r.status).toBe(200);
      expect((await r.json()).ok).toBe(true);
    }
    // Counter is exactly 3 — the 4th request hits the check and short-circuits
    // before calling recordResetAttempt, so it never increments past the threshold
    expect(Number(await env.KV.get(`brute:reset:${EMAIL}`))).toBe(3);
  });
});

// ── POST /token — per-IP gallery lockout ─────────────────────────────────────

describe('POST /token brute-force — per-IP gallery', () => {
  let fetchSpy;
  let token;

  beforeEach(async () => {
    // Simulate unreachable NAS — failures are instant and don't require network
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NAS unreachable'));
    // Gallery record the handler will look up
    await env.KV.put('gallery:gal-1', JSON.stringify({ passphrase: 'pp', assignedUsers: [] }));
    token = await adminToken();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function tokenReq() {
    return new Request('http://worker/token', {
      method: 'POST',
      headers: {
        Origin:                        ORIGIN,
        'Content-Type':                'application/x-www-form-urlencoded',
        Authorization:                 `Bearer ${token}`,
        'CF-Connecting-IP':            IP,
      },
      body: 'galleryId=gal-1',
    });
  }

  it('returns 429 after 10 failed NAS sessions from the same IP', async () => {
    // Attempts 1–10: NAS unreachable → handler records failure, returns 502
    for (let i = 0; i < 10; i++) {
      expect((await handleRequest(tokenReq(), env)).status).toBe(502);
    }
    // Attempt 11: IP counter is at threshold → 429 before any NAS call
    const r = await handleRequest(tokenReq(), env);
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('600');
    expect((await r.json()).error).toMatch(/gallery access/);
  });

  it('clears the counter after a successful NAS session', async () => {
    // Pre-seed counter to 5 (below threshold)
    await env.KV.put(`brute:gallery:ip:${IP}`, '5');

    // Simulate a successful NAS response so getSharingSid resolves
    fetchSpy.mockResolvedValue(new Response(null, {
      status: 200,
      headers: { 'set-cookie': 'sharing_sid=testsid; Path=/' },
    }));

    const r = await handleRequest(tokenReq(), env);
    // Successful exchange → counter cleared, sid returned
    expect(r.status).toBe(200);
    expect(await env.KV.get(`brute:gallery:ip:${IP}`)).toBeNull();
  });
});
