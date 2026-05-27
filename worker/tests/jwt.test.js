import { describe, it, expect } from 'vitest';
import { createJWT, verifyJWT, getAuth } from '../src/jwt.js';

const SECRET = 'test-secret-32-chars-long-enough!';

function makePayload(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { sub: 'test@example.com', id: 'abc123', role: 'admin', iat: now, exp: now + 3600, ...overrides };
}

describe('createJWT', () => {
  it('produces a three-part dot-separated token', async () => {
    const token = await createJWT(makePayload(), SECRET);
    expect(token.split('.')).toHaveLength(3);
  });

  it('encodes the payload correctly', async () => {
    const payload = makePayload({ role: 'client' });
    const token   = await createJWT(payload, SECRET);
    const [, body] = token.split('.');
    const pad   = (4 - (body.length % 4)) % 4;
    const b64   = body.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice(0, pad);
    const decoded = JSON.parse(atob(b64));
    expect(decoded.sub).toBe(payload.sub);
    expect(decoded.role).toBe('client');
  });
});

describe('verifyJWT', () => {
  it('returns the payload for a valid token', async () => {
    const payload = makePayload();
    const token   = await createJWT(payload, SECRET);
    const result  = await verifyJWT(token, SECRET);
    expect(result.sub).toBe(payload.sub);
    expect(result.role).toBe(payload.role);
  });

  it('throws on bad signature', async () => {
    const token  = await createJWT(makePayload(), SECRET);
    const parts  = token.split('.');
    parts[2]     = parts[2].split('').reverse().join('');
    await expect(verifyJWT(parts.join('.'), SECRET)).rejects.toThrow('bad signature');
  });

  it('throws when token has wrong number of parts', async () => {
    await expect(verifyJWT('a.b', SECRET)).rejects.toThrow('bad format');
  });

  it('throws on expired token', async () => {
    const now     = Math.floor(Date.now() / 1000);
    const payload = { sub: 'user@test.com', iat: now - 7200, exp: now - 3600 };
    const token   = await createJWT(payload, SECRET);
    await expect(verifyJWT(token, SECRET)).rejects.toThrow('expired');
  });

  it('throws when signed with different secret', async () => {
    const token = await createJWT(makePayload(), SECRET);
    await expect(verifyJWT(token, 'wrong-secret')).rejects.toThrow();
  });
});

describe('getAuth', () => {
  it('returns null when JWT_SECRET is missing', async () => {
    const request = new Request('https://example.com/', {
      headers: { Authorization: 'Bearer sometoken' },
    });
    const result = await getAuth(request, {});
    expect(result).toBeNull();
  });

  it('returns null when Authorization header is missing', async () => {
    const request = new Request('https://example.com/');
    const result  = await getAuth(request, { JWT_SECRET: SECRET });
    expect(result).toBeNull();
  });

  it('returns null when header does not start with Bearer', async () => {
    const request = new Request('https://example.com/', {
      headers: { Authorization: 'Basic abc123' },
    });
    const result = await getAuth(request, { JWT_SECRET: SECRET });
    expect(result).toBeNull();
  });

  it('returns null for an invalid token', async () => {
    const request = new Request('https://example.com/', {
      headers: { Authorization: 'Bearer invalid.token.here' },
    });
    const result = await getAuth(request, { JWT_SECRET: SECRET });
    expect(result).toBeNull();
  });

  it('returns payload for a valid token', async () => {
    const payload = makePayload({ role: 'admin', sub: 'admin@test.com' });
    const token   = await createJWT(payload, SECRET);
    const request = new Request('https://example.com/', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const result = await getAuth(request, { JWT_SECRET: SECRET });
    expect(result).not.toBeNull();
    expect(result.sub).toBe('admin@test.com');
    expect(result.role).toBe('admin');
  });

  it('returns null for expired token', async () => {
    const now     = Math.floor(Date.now() / 1000);
    const payload = { sub: 'u@test.com', iat: now - 7200, exp: now - 3600 };
    const token   = await createJWT(payload, SECRET);
    const request = new Request('https://example.com/', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const result = await getAuth(request, { JWT_SECRET: SECRET });
    expect(result).toBeNull();
  });
});
