import { describe, it, expect, beforeEach } from 'vitest';
import { createJWT } from '../src/jwt.js';
import {
  handlePortalGalleries,
  handleAdminProjectPortalLink,
  handlePublicProjectPortal,
  handleAdminProjectMessages,
} from '../src/portal.js';

const SECRET = 'test-secret-32-chars-long-enough!';
const ORIGIN = 'https://coastaltravelcompany.com';

function makeKv() {
  const store = new Map();
  return {
    _store: store,
    get:    (k)           => Promise.resolve(store.has(k) ? store.get(k) : null),
    put:    (k, v, _opts) => { store.set(k, v); return Promise.resolve(); },
    delete: (k)           => { store.delete(k); return Promise.resolve(); },
  };
}

function makeD1(rows = []) {
  const stmt = {
    bind: (...args) => stmt,
    all:  () => Promise.resolve({ results: rows }),
    run:  () => Promise.resolve({ success: true }),
    first: () => Promise.resolve(rows[0] || null),
  };
  return { prepare: () => stmt };
}

function makeEnv(kv, d1 = null, overrides = {}) {
  return { KV: kv, DB: d1, JWT_SECRET: SECRET, ...overrides };
}

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

describe('handlePortalGalleries', () => {
  it('returns 401 when no auth', async () => {
    const kv  = makeKv();
    const req = makeRequest('GET', '/portal/galleries');
    const res = await handlePortalGalleries(req, makeEnv(kv));
    expect(res.status).toBe(401);
  });

  it('returns 401 when user not found in KV', async () => {
    const kv    = makeKv();
    const token = await signToken({ sub: 'ghost@test.com', id: 'ghost', role: 'client' });
    const req   = makeRequest('GET', '/portal/galleries', null, token);
    const res   = await handlePortalGalleries(req, makeEnv(kv));
    expect(res.status).toBe(401);
  });

  it('returns 200 with gallery list for authenticated user', async () => {
    const kv = makeKv();
    kv._store.set('user:client@test.com', JSON.stringify({
      id: 'uid1', email: 'client@test.com', role: 'client',
      galleries: ['g1'], verified: true,
    }));
    kv._store.set('gallery:g1', JSON.stringify({
      id: 'g1', eventName: 'Beach', passphrase: 'secret', assignedUsers: [],
    }));
    const token = await signToken({ sub: 'client@test.com', id: 'uid1', role: 'client' });
    const req   = makeRequest('GET', '/portal/galleries', null, token);
    const res   = await handlePortalGalleries(req, makeEnv(kv));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe('g1');
    expect(body[0].passphrase).toBeUndefined();
  });

  it('returns empty array when user has no galleries', async () => {
    const kv = makeKv();
    kv._store.set('user:empty@test.com', JSON.stringify({
      id: 'uid2', email: 'empty@test.com', role: 'client',
      galleries: [], verified: true,
    }));
    const token = await signToken({ sub: 'empty@test.com', id: 'uid2', role: 'client' });
    const req   = makeRequest('GET', '/portal/galleries', null, token);
    const res   = await handlePortalGalleries(req, makeEnv(kv));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

describe('handleAdminProjectPortalLink', () => {
  it('returns 401 when no auth', async () => {
    const kv  = makeKv();
    const req = makeRequest('POST', '/admin/projects/p1/portal-link');
    const res = await handleAdminProjectPortalLink(req, makeEnv(kv), 'p1');
    expect(res.status).toBe(401);
  });

  it('returns 403 when role is client', async () => {
    const kv    = makeKv();
    const token = await signToken({ sub: 'c@test.com', id: 'cid', role: 'client' });
    const req   = makeRequest('POST', '/admin/projects/p1/portal-link', null, token);
    const res   = await handleAdminProjectPortalLink(req, makeEnv(kv), 'p1');
    expect(res.status).toBe(403);
  });

  it('returns 503 when DB is not configured', async () => {
    const kv    = makeKv();
    const token = await signToken({ sub: 'admin@test.com', id: 'aid', role: 'admin' });
    const req   = makeRequest('POST', '/admin/projects/p1/portal-link', null, token);
    const res   = await handleAdminProjectPortalLink(req, makeEnv(kv, null), 'p1');
    expect(res.status).toBe(503);
  });

  it('returns 201 with portal link on success', async () => {
    const kv    = makeKv();
    const d1    = makeD1([]);
    const token = await signToken({ sub: 'admin@test.com', id: 'aid', role: 'admin' });
    const req   = makeRequest('POST', '/admin/projects/p1/portal-link', null, token);
    const res   = await handleAdminProjectPortalLink(req, makeEnv(kv, d1), 'p1');
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project_id).toBe('p1');
    expect(body.url).toContain(ORIGIN);
  });
});

describe('handlePublicProjectPortal', () => {
  it('returns 503 when no DB', async () => {
    const kv  = makeKv();
    const req = makeRequest('GET', '/portal/project/tok');
    const res = await handlePublicProjectPortal(req, 'GET', makeEnv(kv, null), 'tok');
    expect(res.status).toBe(503);
  });

  it('returns 404 when token not found', async () => {
    const kv  = makeKv();
    const d1  = makeD1([]); // no token rows
    const req = makeRequest('GET', '/portal/project/bad-token');
    const res = await handlePublicProjectPortal(req, 'GET', makeEnv(kv, d1), 'bad-token');
    expect(res.status).toBe(404);
  });

  it('returns 200 with project data for GET with valid token', async () => {
    const kv = makeKv();
    // D1 mock needs to support chained calls: first returns token row, subsequent calls return data
    let callCount = 0;
    const d1 = {
      prepare: () => ({
        bind: () => ({
          all: () => {
            callCount++;
            if (callCount === 1) return Promise.resolve({ results: [{ id: 'tok1', project_id: 'proj1' }] });
            if (callCount === 2) return Promise.resolve({ results: [{ id: 'proj1', client_name: 'Alice', property: 'Beach', stage: 'Inquiry', created_at: '2024-01-01' }] });
            return Promise.resolve({ results: [] });
          },
          run: () => Promise.resolve({ success: true }),
        }),
      }),
    };
    const req = makeRequest('GET', '/portal/project/tok1');
    const res = await handlePublicProjectPortal(req, 'GET', makeEnv(kv, d1), 'tok1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project).toBeDefined();
  });
});

describe('handleAdminProjectMessages', () => {
  it('returns 401 when no auth', async () => {
    const kv  = makeKv();
    const req = makeRequest('GET', '/admin/projects/p1/messages');
    const res = await handleAdminProjectMessages(req, 'GET', makeEnv(kv), 'p1');
    expect(res.status).toBe(401);
  });

  it('returns 403 when role is client', async () => {
    const kv    = makeKv();
    const token = await signToken({ sub: 'c@test.com', id: 'cid', role: 'client' });
    const req   = makeRequest('GET', '/admin/projects/p1/messages', null, token);
    const res   = await handleAdminProjectMessages(req, 'GET', makeEnv(kv), 'p1');
    expect(res.status).toBe(403);
  });

  it('returns 503 when DB is not configured', async () => {
    const kv    = makeKv();
    const token = await signToken({ sub: 'admin@test.com', id: 'aid', role: 'admin' });
    const req   = makeRequest('GET', '/admin/projects/p1/messages', null, token);
    const res   = await handleAdminProjectMessages(req, 'GET', makeEnv(kv, null), 'p1');
    expect(res.status).toBe(503);
  });

  it('returns 200 with messages list for GET', async () => {
    const kv    = makeKv();
    const d1    = makeD1([{ id: 'm1', content: 'Hello', sender: 'admin', created_at: '2024-01-01' }]);
    const token = await signToken({ sub: 'admin@test.com', id: 'aid', role: 'admin' });
    const req   = makeRequest('GET', '/admin/projects/p1/messages', null, token);
    const res   = await handleAdminProjectMessages(req, 'GET', makeEnv(kv, d1), 'p1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('returns 201 when POST creates a message', async () => {
    const kv    = makeKv();
    const d1    = makeD1([]);
    const token = await signToken({ sub: 'admin@test.com', id: 'aid', role: 'admin' });
    const req   = makeRequest('POST', '/admin/projects/p1/messages', { content: 'Hello client!' }, token);
    const res   = await handleAdminProjectMessages(req, 'POST', makeEnv(kv, d1), 'p1');
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sender).toBe('admin');
    expect(body.content).toBe('Hello client!');
  });

  it('returns 400 when POST body has no content', async () => {
    const kv    = makeKv();
    const d1    = makeD1([]);
    const token = await signToken({ sub: 'admin@test.com', id: 'aid', role: 'admin' });
    const req   = makeRequest('POST', '/admin/projects/p1/messages', { content: '' }, token);
    const res   = await handleAdminProjectMessages(req, 'POST', makeEnv(kv, d1), 'p1');
    expect(res.status).toBe(400);
  });
});
