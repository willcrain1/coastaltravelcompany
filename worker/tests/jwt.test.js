import { describe, it, expect } from 'vitest';
import { createJWT, verifyJWT, getAuth, makeAuthCookie, clearAuthCookie } from '../src/jwt.js';

const SECRET = 'test-secret-for-unit-tests-at-least-32';

function futureExp() { return Math.floor(Date.now() / 1000) + 3600; }
function pastExp()   { return Math.floor(Date.now() / 1000) - 1; }

describe('createJWT / verifyJWT', () => {
  it('round-trips a payload correctly', async () => {
    const payload = { sub: 'user@test.com', role: 'admin', exp: futureExp() };
    const token   = await createJWT(payload, SECRET);
    expect(token.split('.').length).toBe(3);
    const result  = await verifyJWT(token, SECRET);
    expect(result.sub).toBe('user@test.com');
    expect(result.role).toBe('admin');
  });

  it('throws on wrong number of parts', async () => {
    await expect(verifyJWT('a.b.c.d', SECRET)).rejects.toThrow('bad format');
    await expect(verifyJWT('only.two', SECRET)).rejects.toThrow('bad format');
  });

  it('throws on tampered signature', async () => {
    const token = await createJWT({ sub: 'x' }, SECRET);
    const parts  = token.split('.');
    parts[2]     = 'invalidsignature';
    await expect(verifyJWT(parts.join('.'), SECRET)).rejects.toThrow('bad signature');
  });

  it('throws on expired token', async () => {
    const token = await createJWT({ sub: 'x', exp: pastExp() }, SECRET);
    await expect(verifyJWT(token, SECRET)).rejects.toThrow('expired');
  });

  it('accepts token without exp field', async () => {
    const token  = await createJWT({ sub: 'no-exp' }, SECRET);
    const result = await verifyJWT(token, SECRET);
    expect(result.sub).toBe('no-exp');
  });

  it('throws when signed with a different secret', async () => {
    const token = await createJWT({ sub: 'x', exp: futureExp() }, 'other-secret');
    await expect(verifyJWT(token, SECRET)).rejects.toThrow('bad signature');
  });
});

describe('getAuth', () => {
  it('returns null when JWT_SECRET is not configured', async () => {
    const req = new Request('http://test', { headers: { Authorization: 'Bearer xxx' } });
    expect(await getAuth(req, {})).toBeNull();
  });
  it('returns null when Authorization header is missing', async () => {
    expect(await getAuth(new Request('http://test'), { JWT_SECRET: SECRET })).toBeNull();
  });
  it('returns null when header does not start with Bearer', async () => {
    const req = new Request('http://test', { headers: { Authorization: 'Token abc' } });
    expect(await getAuth(req, { JWT_SECRET: SECRET })).toBeNull();
  });
  it('returns null for an invalid token', async () => {
    const req = new Request('http://test', { headers: { Authorization: 'Bearer bad.token.here' } });
    expect(await getAuth(req, { JWT_SECRET: SECRET })).toBeNull();
  });
  it('returns payload for a valid token in Authorization header', async () => {
    const payload = { sub: 'a@b.com', role: 'client', exp: futureExp() };
    const token   = await createJWT(payload, SECRET);
    const req     = new Request('http://test', { headers: { Authorization: `Bearer ${token}` } });
    const result  = await getAuth(req, { JWT_SECRET: SECRET });
    expect(result.sub).toBe('a@b.com');
    expect(result.role).toBe('client');
  });
  it('returns payload for a valid token in auth_token cookie', async () => {
    const payload = { sub: 'cookie@test.com', role: 'client', exp: futureExp() };
    const token   = await createJWT(payload, SECRET);
    const req     = new Request('http://test', { headers: { Cookie: `auth_token=${token}` } });
    const result  = await getAuth(req, { JWT_SECRET: SECRET });
    expect(result?.sub).toBe('cookie@test.com');
  });
  it('prefers Authorization header over cookie when both present', async () => {
    const headerPayload = { sub: 'header@test.com', role: 'admin', exp: futureExp() };
    const cookiePayload = { sub: 'cookie@test.com', role: 'client', exp: futureExp() };
    const headerToken   = await createJWT(headerPayload, SECRET);
    const cookieToken   = await createJWT(cookiePayload, SECRET);
    const req = new Request('http://test', {
      headers: { Authorization: `Bearer ${headerToken}`, Cookie: `auth_token=${cookieToken}` },
    });
    const result = await getAuth(req, { JWT_SECRET: SECRET });
    expect(result?.sub).toBe('header@test.com');
  });
  it('returns null for an invalid cookie token', async () => {
    const req = new Request('http://test', { headers: { Cookie: 'auth_token=bad.token.here' } });
    expect(await getAuth(req, { JWT_SECRET: SECRET })).toBeNull();
  });
  it('returns null when cookie is present but JWT_SECRET is missing', async () => {
    const req = new Request('http://test', { headers: { Cookie: 'auth_token=sometoken' } });
    expect(await getAuth(req, {})).toBeNull();
  });

  // ── Bearer-to-cookie fallthrough (regression guard) ───────────────────────
  // When a cross-origin Bearer token is expired or invalid, getAuth must fall
  // through to the HttpOnly cookie so sliding-window refresh still works.

  it('falls through to cookie when Bearer token is expired', async () => {
    const expired     = await createJWT({ sub: 'exp@t.com', exp: pastExp() }, SECRET);
    const cookieTok   = await createJWT({ sub: 'exp@t.com', exp: futureExp() }, SECRET);
    const req = new Request('http://test', {
      headers: { Authorization: `Bearer ${expired}`, Cookie: `auth_token=${cookieTok}` },
    });
    const result = await getAuth(req, { JWT_SECRET: SECRET });
    expect(result?.sub).toBe('exp@t.com');
  });

  it('falls through to cookie when Bearer token has a bad signature', async () => {
    const cookieTok = await createJWT({ sub: 'badsig@t.com', exp: futureExp() }, SECRET);
    const req = new Request('http://test', {
      headers: { Authorization: 'Bearer bad.invalid.token', Cookie: `auth_token=${cookieTok}` },
    });
    const result = await getAuth(req, { JWT_SECRET: SECRET });
    expect(result?.sub).toBe('badsig@t.com');
  });

  it('returns null when both Bearer and cookie are expired', async () => {
    const expBearer = await createJWT({ sub: 'both@t.com', exp: pastExp() }, SECRET);
    const expCookie = await createJWT({ sub: 'both@t.com', exp: pastExp() }, SECRET);
    const req = new Request('http://test', {
      headers: { Authorization: `Bearer ${expBearer}`, Cookie: `auth_token=${expCookie}` },
    });
    expect(await getAuth(req, { JWT_SECRET: SECRET })).toBeNull();
  });

  it('returns null when both Bearer and cookie are invalid', async () => {
    const req = new Request('http://test', {
      headers: { Authorization: 'Bearer totally.bad.token', Cookie: 'auth_token=also.bad.token' },
    });
    expect(await getAuth(req, { JWT_SECRET: SECRET })).toBeNull();
  });
});

describe('makeAuthCookie / clearAuthCookie', () => {
  it('makeAuthCookie without domain uses SameSite=None (cross-origin workers.dev)', () => {
    const cookie = makeAuthCookie('my-jwt-token');
    expect(cookie).toContain('auth_token=my-jwt-token');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=None');
    expect(cookie).not.toContain('Domain=');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=604800');
  });
  it('makeAuthCookie with domain uses SameSite=Lax and sets Domain (custom domain)', () => {
    const cookie = makeAuthCookie('my-jwt-token', 604800, 'preprod.coastaltravelcompany.com');
    expect(cookie).toContain('auth_token=my-jwt-token');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Domain=preprod.coastaltravelcompany.com');
    expect(cookie).not.toContain('SameSite=None');
  });
  it('makeAuthCookie accepts a custom maxAge', () => {
    const cookie = makeAuthCookie('tok', 1800);
    expect(cookie).toContain('Max-Age=1800');
  });
  it('clearAuthCookie without domain uses SameSite=None', () => {
    const cookie = clearAuthCookie();
    expect(cookie).toContain('auth_token=;');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=None');
  });
  it('clearAuthCookie with domain uses SameSite=Lax and sets Domain', () => {
    const cookie = clearAuthCookie('preprod.coastaltravelcompany.com');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Domain=preprod.coastaltravelcompany.com');
    expect(cookie).toContain('Max-Age=0');
  });
});
