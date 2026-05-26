/**
 * Security / auth-boundary tests.
 *
 * For every admin endpoint: verify that
 *   - missing Authorization header → 401
 *   - valid JWT with role=client    → 403
 *   - JWT signed with wrong secret  → 401
 *
 * Portal endpoints (accessible to any authenticated user) are checked
 * separately: they should return 401 for unauthenticated requests.
 */
import { describe, it, expect } from 'vitest';
import { handleRequest } from '../src/router.js';
import { createJWT } from '../src/jwt.js';
import { makeKv, makeEnv, adminToken, clientToken, req, SECRET, ORIGIN } from './integration/helpers.js';

const WRONG_SECRET = 'wrong-secret-at-least-32-chars-yeah!!';

async function badToken() {
  return createJWT(
    { sub: 'x@t.com', id: 'xid', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 },
    WRONG_SECRET,
  );
}

// Each entry: [method, path, label]
const ADMIN_ROUTES = [
  ['GET',    '/admin/galleries',                         'list galleries'],
  ['POST',   '/admin/galleries',                         'create gallery'],
  ['PUT',    '/admin/galleries/g1',                      'update gallery'],
  ['DELETE', '/admin/galleries/g1',                      'delete gallery'],
  ['GET',    '/admin/users',                             'list users'],
  ['POST',   '/admin/users',                             'create user'],
  ['PUT',    '/admin/users/u1',                          'update user'],
  ['DELETE', '/admin/users/u1',                          'delete user'],
  ['PATCH',  '/admin/users/u1/role',                     'update user role'],
  ['GET',    '/admin/packages',                          'list packages'],
  ['POST',   '/admin/packages',                          'create package'],
  ['GET',    '/admin/questionnaires',                    'list questionnaire sets'],
  ['POST',   '/admin/questionnaires',                    'create questionnaire set'],
  ['GET',    '/admin/projects',                          'list projects'],
  ['POST',   '/admin/projects',                          'create project'],
  ['PUT',    '/admin/projects/p1',                       'update project'],
  ['DELETE', '/admin/projects/p1',                       'delete project'],
  ['GET',    '/admin/projects/p1/notes',                 'list project notes'],
  ['GET',    '/admin/projects/p1/documents',             'list project documents'],
  ['GET',    '/admin/projects/p1/proposals',             'list project proposals'],
  ['GET',    '/admin/availability',                      'get availability'],
  ['PUT',    '/admin/availability',                      'put availability'],
  ['GET',    '/admin/blocked-dates',                     'list blocked dates'],
  ['POST',   '/admin/blocked-dates',                     'add blocked date'],
  ['GET',    '/admin/automations',                       'get automations'],
  ['PUT',    '/admin/automations',                       'put automations'],
  ['GET',    '/admin/automation-logs',                   'get automation logs'],
  ['GET',    '/admin/contract-templates',                'list contract templates'],
  ['POST',   '/admin/contract-templates',                'create contract template'],
  ['GET',    '/admin/projects/p1/contracts',             'list project contracts'],
  ['POST',   '/admin/projects/p1/contracts',             'create project contract'],
  ['POST',   '/admin/projects/p1/contracts/c1/countersign', 'countersign contract'],
  ['GET',    '/admin/projects/p1/invoices',              'list project invoices'],
  ['POST',   '/admin/projects/p1/invoices',              'create invoice'],
  ['GET',    '/admin/walkthroughs',                      'list walkthroughs'],
  ['POST',   '/admin/walkthroughs',                      'create walkthrough'],
];

const PORTAL_ROUTES = [
  ['GET', '/portal/galleries', 'portal galleries'],
  ['GET', '/portal/invoices',  'portal invoices'],
];

function makeTestEnv() {
  return makeEnv(makeKv());
}

describe('admin route auth boundaries', () => {
  for (const [method, path, label] of ADMIN_ROUTES) {
    it(`401 unauthenticated: ${label} (${method} ${path})`, async () => {
      const r = await handleRequest(req(method, path), makeTestEnv());
      expect(r.status).toBe(401);
    });

    it(`403 client role: ${label} (${method} ${path})`, async () => {
      const token = await clientToken();
      const r = await handleRequest(req(method, path, { token, body: method !== 'GET' ? {} : undefined }), makeTestEnv());
      expect(r.status).toBe(403);
    });

    it(`401 tampered JWT: ${label} (${method} ${path})`, async () => {
      const token = await badToken();
      const r = await handleRequest(req(method, path, { token }), makeTestEnv());
      expect(r.status).toBe(401);
    });
  }
});

describe('portal route auth boundaries', () => {
  for (const [method, path, label] of PORTAL_ROUTES) {
    it(`401 unauthenticated: ${label} (${method} ${path})`, async () => {
      const r = await handleRequest(req(method, path), makeTestEnv());
      expect(r.status).toBe(401);
    });

    it(`401 tampered JWT: ${label} (${method} ${path})`, async () => {
      const token = await badToken();
      const r = await handleRequest(req(method, path, { token }), makeTestEnv());
      expect(r.status).toBe(401);
    });
  }
});

describe('origin enforcement', () => {
  it('403 when Origin header is missing', async () => {
    const token = await adminToken();
    const r = await handleRequest(
      new Request('http://worker/admin/galleries', {
        headers: { 'Authorization': `Bearer ${token}` },
      }),
      makeTestEnv(),
    );
    expect(r.status).toBe(403);
  });

  it('403 when Origin header is an unknown domain', async () => {
    const token = await adminToken();
    const r = await handleRequest(
      new Request('http://worker/admin/galleries', {
        headers: { 'Authorization': `Bearer ${token}`, 'Origin': 'https://evil.com' },
      }),
      makeTestEnv(),
    );
    expect(r.status).toBe(403);
  });

  it('204 for OPTIONS preflight from allowed origin', async () => {
    const r = await handleRequest(
      new Request('http://worker/admin/galleries', {
        method: 'OPTIONS',
        headers: { 'Origin': ORIGIN },
      }),
      makeTestEnv(),
    );
    expect(r.status).toBe(204);
  });
});

describe('JWT tampering', () => {
  it('401 when JWT algorithm is tampered (alg:none style)', async () => {
    const token = await adminToken();
    // Flip a character in the signature segment to invalidate it.
    const parts = token.split('.');
    const sig   = parts[2];
    parts[2]    = sig.slice(0, -1) + (sig.at(-1) === 'A' ? 'B' : 'A');
    const tampered = parts.join('.');
    const r = await handleRequest(req('GET', '/admin/galleries', { token: tampered }), makeTestEnv());
    expect(r.status).toBe(401);
  });

  it('401 when JWT payload is tampered', async () => {
    const token = await adminToken();
    const parts = token.split('.');
    // Modify the payload to elevate role — signature will no longer match.
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    payload.role = 'superadmin';
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tampered = parts.join('.');
    const r = await handleRequest(req('GET', '/admin/galleries', { token: tampered }), makeTestEnv());
    expect(r.status).toBe(401);
  });

  it('401 for expired JWT', async () => {
    const expired = await createJWT(
      { sub: 'a@t.com', id: 'aid', role: 'admin', exp: Math.floor(Date.now() / 1000) - 1 },
      SECRET,
    );
    const r = await handleRequest(req('GET', '/admin/galleries', { token: expired }), makeTestEnv());
    expect(r.status).toBe(401);
  });
});
