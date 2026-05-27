import { describe, it, expect } from 'vitest';
import { createJWT, verifyJWT, getAuth } from '../src/jwt.js';

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
  it('returns payload for a valid token', async () => {
    const payload = { sub: 'a@b.com', role: 'client', exp: futureExp() };
    const token   = await createJWT(payload, SECRET);
    const req     = new Request('http://test', { headers: { Authorization: `Bearer ${token}` } });
    const result  = await getAuth(req, { JWT_SECRET: SECRET });
    expect(result.sub).toBe('a@b.com');
    expect(result.role).toBe('client');
  });
});
