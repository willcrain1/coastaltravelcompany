/**
 * Integration: D1-backed CRUD flows through the router.
 *
 * Uses a real in-memory SQLite database (via better-sqlite3) wrapped in a
 * D1-shaped adapter so that SQL is actually executed and results verified
 * end-to-end through handleRequest.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { handleRequest } from '../../src/router.js';
import { makeKv, makeSqliteDb, makeD1, makeEnv, adminToken, clientToken, req } from './helpers.js';

let env;
let tok;

beforeEach(async () => {
  const db = makeSqliteDb();
  env = makeEnv(makeKv(), makeD1(db));
  tok = await adminToken();
});

// ─── Projects ────────────────────────────────────────────────────────────────

describe('projects CRUD', () => {
  it('GET /admin/projects returns empty list initially', async () => {
    const r = await handleRequest(req('GET', '/admin/projects', { token: tok }), env);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it('POST /admin/projects creates a project', async () => {
    const r = await handleRequest(
      req('POST', '/admin/projects', {
        token: tok,
        body: { client_name: 'Jane Doe', client_email: 'jane@t.com' },
      }),
      env,
    );
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.id).toBeTruthy();
    expect(b.client_name).toBe('Jane Doe');
    expect(b.stage).toBe('Inquiry');
  });

  it('GET /admin/projects lists the created project', async () => {
    await handleRequest(
      req('POST', '/admin/projects', {
        token: tok,
        body: { client_name: 'Jane Doe', client_email: 'jane@t.com' },
      }),
      env,
    );
    const r = await handleRequest(req('GET', '/admin/projects', { token: tok }), env);
    const list = await r.json();
    expect(list).toHaveLength(1);
    expect(list[0].client_name).toBe('Jane Doe');
  });

  it('POST /admin/projects 400 on missing required fields', async () => {
    const r = await handleRequest(
      req('POST', '/admin/projects', { token: tok, body: { client_name: 'X' } }),
      env,
    );
    expect(r.status).toBe(400);
  });

  it('PUT /admin/projects/:id updates stage', async () => {
    const create = await handleRequest(
      req('POST', '/admin/projects', {
        token: tok,
        body: { client_name: 'John', client_email: 'john@t.com' },
      }),
      env,
    );
    const { id } = await create.json();

    const r = await handleRequest(
      req('PUT', `/admin/projects/${id}`, { token: tok, body: { stage: 'Booked' } }),
      env,
    );
    expect(r.status).toBe(200);
    expect((await r.json()).stage).toBe('Booked');
  });

  it('DELETE /admin/projects/:id removes the project', async () => {
    const create = await handleRequest(
      req('POST', '/admin/projects', {
        token: tok,
        body: { client_name: 'Del', client_email: 'del@t.com' },
      }),
      env,
    );
    const { id } = await create.json();

    await handleRequest(req('DELETE', `/admin/projects/${id}`, { token: tok }), env);

    const listRes = await handleRequest(req('GET', '/admin/projects', { token: tok }), env);
    expect(await listRes.json()).toEqual([]);
  });
});

// ─── Service packages ─────────────────────────────────────────────────────────

describe('packages CRUD', () => {
  it('GET /admin/packages returns empty list initially', async () => {
    const r = await handleRequest(req('GET', '/admin/packages', { token: tok }), env);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it('POST /admin/packages creates a package', async () => {
    const r = await handleRequest(
      req('POST', '/admin/packages', {
        token: tok,
        body: { name: 'Bronze', base_price: 500 },
      }),
      env,
    );
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.id).toBeTruthy();
    expect(b.name).toBe('Bronze');
  });

  it('PUT /admin/packages/:id updates name', async () => {
    const create = await handleRequest(
      req('POST', '/admin/packages', { token: tok, body: { name: 'Old', base_price: 100 } }),
      env,
    );
    const { id } = await create.json();

    const r = await handleRequest(
      req('PUT', `/admin/packages/${id}`, { token: tok, body: { name: 'New' } }),
      env,
    );
    expect(r.status).toBe(200);
    expect((await r.json()).name).toBe('New');
  });

  it('DELETE /admin/packages/:id removes the package', async () => {
    const create = await handleRequest(
      req('POST', '/admin/packages', { token: tok, body: { name: 'Rm', base_price: 0 } }),
      env,
    );
    const { id } = await create.json();
    const r = await handleRequest(req('DELETE', `/admin/packages/${id}`, { token: tok }), env);
    expect(r.status).toBe(200);
  });
});

// ─── Project notes ────────────────────────────────────────────────────────────

describe('project notes', () => {
  let projectId;

  beforeEach(async () => {
    const r = await handleRequest(
      req('POST', '/admin/projects', {
        token: tok,
        body: { client_name: 'N', client_email: 'n@t.com' },
      }),
      env,
    );
    projectId = (await r.json()).id;
  });

  it('GET /admin/projects/:id/notes returns empty list', async () => {
    const r = await handleRequest(
      req('GET', `/admin/projects/${projectId}/notes`, { token: tok }),
      env,
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it('POST /admin/projects/:id/notes adds a note', async () => {
    const r = await handleRequest(
      req('POST', `/admin/projects/${projectId}/notes`, {
        token: tok,
        body: { content: 'Hello' },
      }),
      env,
    );
    expect(r.status).toBe(201);
    expect((await r.json()).content).toBe('Hello');
  });
});

// ─── Gallery token exchange ───────────────────────────────────────────────────

describe('gallery token exchange (POST /token)', () => {
  it('returns sid and stores tok:* in KV after successful session', async () => {
    // Set up gallery with a passphrase in KV
    const kv = makeKv();
    await kv.put('gallery:g1', JSON.stringify({ id: 'g1', passphrase: 'share-abc123' }));
    await kv.put('galleries_list', JSON.stringify(['g1']));
    const testEnv = makeEnv(kv); // no DB needed for token exchange

    // Stub getSharingSid's outbound fetch calls — NAS is not reachable in tests
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('sharing_id=')) {
        // Synology login API response
        return new Response(JSON.stringify({ success: true, data: { sid: 'nas-sid-xyz' } }), {
          headers: { 'set-cookie': 'sharing_sid=nas-sid-xyz; Path=/' },
        });
      }
      return new Response('', { headers: { 'set-cookie': 'sharing_sid=fallback-sid; Path=/' } });
    };

    try {
      const r = await handleRequest(
        new Request('http://worker/token', {
          method: 'POST',
          headers: {
            'Origin': 'https://coastaltravelcompany.com',
            'Authorization': `Bearer ${tok}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'galleryId=g1',
        }),
        testEnv,
      );
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.sid).toBeTruthy();

      // KV should have a tok:<sid> entry
      const stored = await kv.get(`tok:${body.sid}`);
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored);
      expect(parsed.passphrase).toBe('share-abc123');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('404 when gallery does not exist in KV', async () => {
    const kv = makeKv();
    const testEnv = makeEnv(kv);
    const r = await handleRequest(
      new Request('http://worker/token', {
        method: 'POST',
        headers: {
          'Origin': 'https://coastaltravelcompany.com',
          'Authorization': `Bearer ${tok}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'galleryId=missing',
      }),
      testEnv,
    );
    expect(r.status).toBe(404);
  });

  it('400 when galleryId is missing from body', async () => {
    const r = await handleRequest(
      new Request('http://worker/token', {
        method: 'POST',
        headers: {
          'Origin': 'https://coastaltravelcompany.com',
          'Authorization': `Bearer ${tok}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: '',
      }),
      makeEnv(makeKv()),
    );
    expect(r.status).toBe(400);
  });
});

// ─── Auth enforcement on DB routes ───────────────────────────────────────────

describe('DB route auth enforcement', () => {
  it('GET /admin/projects 401 when unauthenticated', async () => {
    const r = await handleRequest(req('GET', '/admin/projects'), env);
    expect(r.status).toBe(401);
  });

  it('POST /admin/projects 403 for client role', async () => {
    const ctok = await clientToken();
    const r = await handleRequest(
      req('POST', '/admin/projects', { token: ctok, body: {} }),
      env,
    );
    expect(r.status).toBe(403);
  });

  it('503 when DB is not configured', async () => {
    const noDbEnv = makeEnv(makeKv()); // no DB
    const r = await handleRequest(req('GET', '/admin/projects', { token: tok }), noDbEnv);
    expect(r.status).toBe(503);
  });
});
