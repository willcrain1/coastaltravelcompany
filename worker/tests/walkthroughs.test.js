import { describe, it, expect, beforeEach } from 'vitest';
import { createJWT } from '../src/jwt.js';
import {
  handlePublicWalkthroughs,
  handleAdminWalkthroughs,
  handleAdminWalkthroughById,
} from '../src/walkthroughs.js';

const SECRET = 'test-secret-32-chars-long-enough!';
const ORIGIN = 'https://coastaltravelcompany.com';

async function signToken(payload) {
  const now = Math.floor(Date.now() / 1000);
  return createJWT({ iat: now, exp: now + 3600, ...payload }, SECRET);
}

function makeRequest(method, path, body = null, token = null) {
  const headers = { 'Content-Type': 'application/json', 'Origin': ORIGIN };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return new Request('https://worker.example.com' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function makeEnv(d1, overrides = {}) {
  return { DB: d1, JWT_SECRET: SECRET, ...overrides };
}

function makeD1(rows = []) {
  const stmt = {
    bind: (..._args) => stmt,
    all:  () => Promise.resolve({ results: rows }),
    run:  () => Promise.resolve({ success: true }),
    first: () => Promise.resolve(rows[0] || null),
  };
  return { prepare: () => stmt };
}

describe('handlePublicWalkthroughs', () => {
  it('returns 200 with list of published walkthroughs', async () => {
    const rows = [
      { id: 'w1', title: 'Beachfront Villa', property_name: 'Villa 1', embed_url: 'https://example.com/embed', published: 1, sort_order: 0 },
    ];
    const d1  = makeD1(rows);
    const req = makeRequest('GET', '/public/walkthroughs');
    const res = await handlePublicWalkthroughs(req, makeEnv(d1));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe('w1');
  });

  it('returns empty array when no walkthroughs', async () => {
    const d1  = makeD1([]);
    const req = makeRequest('GET', '/public/walkthroughs');
    const res = await handlePublicWalkthroughs(req, makeEnv(d1));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

describe('handleAdminWalkthroughs', () => {
  it('returns 401 when no auth', async () => {
    const d1  = makeD1([]);
    const req = makeRequest('GET', '/admin/walkthroughs');
    const res = await handleAdminWalkthroughs(req, makeEnv(d1));
    expect(res.status).toBe(401);
  });

  it('returns 403 for client role', async () => {
    const token = await signToken({ sub: 'c@test.com', id: 'cid', role: 'client' });
    const d1    = makeD1([]);
    const req   = makeRequest('GET', '/admin/walkthroughs', null, token);
    const res   = await handleAdminWalkthroughs(req, makeEnv(d1));
    expect(res.status).toBe(403);
  });

  it('returns 200 with all walkthroughs for GET (admin)', async () => {
    const rows  = [{ id: 'w1', title: 'Test', property_name: 'P1', embed_url: 'u', published: 0, sort_order: 0 }];
    const token = await signToken({ sub: 'admin@test.com', id: 'aid', role: 'admin' });
    const d1    = makeD1(rows);
    const req   = makeRequest('GET', '/admin/walkthroughs', null, token);
    const res   = await handleAdminWalkthroughs(req, makeEnv(d1));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].id).toBe('w1');
  });

  it('returns 201 when POST creates a walkthrough', async () => {
    const token = await signToken({ sub: 'admin@test.com', id: 'aid', role: 'admin' });
    const d1    = makeD1([{ id: 'new-id', title: 'New Walk', property_name: 'P2', embed_url: 'u2', published: 0, sort_order: 0, created_at: '2024-01-01' }]);
    const req   = makeRequest('POST', '/admin/walkthroughs', {
      title: 'New Walk', property_name: 'P2', embed_url: 'u2',
    }, token);
    const res = await handleAdminWalkthroughs(req, makeEnv(d1));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe('New Walk');
  });

  it('returns 405 for unsupported method', async () => {
    const token = await signToken({ sub: 'admin@test.com', id: 'aid', role: 'admin' });
    const d1    = makeD1([]);
    const req   = makeRequest('DELETE', '/admin/walkthroughs', null, token);
    const res   = await handleAdminWalkthroughs(req, makeEnv(d1));
    expect(res.status).toBe(405);
  });
});

describe('handleAdminWalkthroughById', () => {
  it('returns 401 when no auth', async () => {
    const d1  = makeD1([]);
    const req = makeRequest('PUT', '/admin/walkthroughs/w1', { title: 'Updated' });
    const res = await handleAdminWalkthroughById(req, makeEnv(d1), 'w1');
    expect(res.status).toBe(401);
  });

  it('returns 403 for client role', async () => {
    const token = await signToken({ sub: 'c@test.com', id: 'cid', role: 'client' });
    const d1    = makeD1([]);
    const req   = makeRequest('PUT', '/admin/walkthroughs/w1', { title: 'X' }, token);
    const res   = await handleAdminWalkthroughById(req, makeEnv(d1), 'w1');
    expect(res.status).toBe(403);
  });

  it('returns 404 for PUT on non-existent walkthrough', async () => {
    const token = await signToken({ sub: 'admin@test.com', id: 'aid', role: 'admin' });
    const d1    = makeD1([]); // first query returns empty (not found)
    const req   = makeRequest('PUT', '/admin/walkthroughs/w1', { title: 'X' }, token);
    const res   = await handleAdminWalkthroughById(req, makeEnv(d1), 'w1');
    expect(res.status).toBe(404);
  });

  it('returns 200 for PUT on existing walkthrough', async () => {
    const token = await signToken({ sub: 'admin@test.com', id: 'aid', role: 'admin' });
    let callCount = 0;
    const d1 = {
      prepare: () => ({
        bind: () => ({
          first: () => {
            callCount++;
            if (callCount === 1) return Promise.resolve({ id: 'w1' }); // exists check
            return Promise.resolve({ id: 'w1', title: 'Updated', property_name: 'P1', embed_url: 'u', published: 0, sort_order: 0 }); // fetch after update
          },
          run: () => Promise.resolve({ success: true }),
        }),
      }),
    };
    const req = makeRequest('PUT', '/admin/walkthroughs/w1', {
      title: 'Updated', property_name: 'P1', embed_url: 'u', sort_order: 0, published: false,
    }, token);
    const res = await handleAdminWalkthroughById(req, makeEnv(d1), 'w1');
    expect(res.status).toBe(200);
  });

  it('returns 200 for DELETE', async () => {
    const token = await signToken({ sub: 'admin@test.com', id: 'aid', role: 'admin' });
    const d1    = makeD1([]);
    const req   = makeRequest('DELETE', '/admin/walkthroughs/w1', null, token);
    const res   = await handleAdminWalkthroughById(req, makeEnv(d1), 'w1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('returns 405 for unsupported method', async () => {
    const token = await signToken({ sub: 'admin@test.com', id: 'aid', role: 'admin' });
    const d1    = makeD1([]);
    const req   = makeRequest('POST', '/admin/walkthroughs/w1', null, token);
    const res   = await handleAdminWalkthroughById(req, makeEnv(d1), 'w1');
    expect(res.status).toBe(405);
  });
});
