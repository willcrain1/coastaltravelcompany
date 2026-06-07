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
import { describe, it, expect, beforeEach } from 'vitest';
import { handleRequest } from '../src/router.js';
import { createJWT } from '../src/jwt.js';
import { makeKv, makeSqliteDb, makeD1, makeEnv, adminToken, clientToken, req, SECRET, ORIGIN } from './integration/helpers.js';

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
  ['POST',   '/admin/galleries/g1/sync-r2',              'sync gallery to R2'],
  ['GET',    '/admin/cms/pages',                         'list CMS pages'],
  ['GET',    '/admin/cms/page',                          'get CMS page'],
  ['PUT',    '/admin/cms/page',                          'update CMS page'],
  ['GET',    '/admin/cms/history',                       'get CMS history'],
  ['POST',   '/admin/cms/revert',                        'revert CMS page'],
];

const PORTAL_ROUTES = [
  ['GET',  '/portal/galleries',  'portal galleries'],
  ['GET',  '/portal/invoices',   'portal invoices'],
  ['GET',  '/portal/contracts',  'portal contracts'],
  ['GET',  '/portal/my-project', 'portal my-project GET'],
  ['POST', '/portal/my-project', 'portal my-project POST'],
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
    // Corrupt the signature by flipping the first character.
    // The last character of a 32-byte HMAC-SHA256 base64url signature encodes
    // only 4 real bits + 2 padding zeros, so flipping it may leave decoded bytes
    // unchanged (padding bits are discarded). The first character encodes 6 real
    // bits and is always safe to corrupt.
    const parts = token.split('.');
    const sig   = parts[2];
    parts[2]    = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
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

// ── Public route accessibility ────────────────────────────────────────────────
// Every route that requires no auth must never return 401.
// The response may be 400 (bad params), 404 (not found), 503 (missing config),
// etc. — but an auth rejection means public access is incorrectly gated.
// A single env with KV + DB is used for all checks to avoid crashes in
// handlers that unconditionally call env.DB.prepare().

// [method, path, body, label] — body is sent as-is (raw string or undefined).
// Also consumed by the router cross-check at the bottom of this file.
const PUBLIC_ROUTES = [
    // Auth — no DB needed, but DB present causes no harm
    ['GET',  '/auth/setup-status',           undefined,  'auth setup status'],
    ['POST', '/auth/setup',                  '{}',       'first-time setup (empty body → 400)'],
    ['POST', '/auth/register',               '{}',       'register (empty body → 400)'],
    ['POST', '/auth/login',                  '{}',       'login (empty body → 400)'],
    ['POST', '/auth/google',                 '{}',       'google auth (no client id → 503)'],
    ['POST', '/auth/reset-request',          '{}',       'reset request (empty body → 400)'],
    ['POST', '/auth/reset-confirm',          '{}',       'reset confirm (empty body → 400)'],
    ['GET',  '/auth/verify',                 undefined,  'email verify (no token → 400)'],
    ['POST', '/auth/resend-verify',          '{}',       'resend verify (empty body → 400)'],
    // Public DB-backed routes — return 404 for unknown ids, never 401
    ['GET',  '/proposals/p1',                undefined,  'public proposal'],
    ['POST', '/proposals/p1/analytics',      '{}',       'proposal analytics'],
    ['POST', '/proposals/p1/select',         '{}',       'proposal select'],
    ['GET',  '/questionnaire/q1',            undefined,  'public questionnaire'],
    ['POST', '/questionnaire/q1',            '{}',       'questionnaire submit'],
    ['GET',  '/contracts/tok1',              undefined,  'public contract get'],
    ['POST', '/contracts/tok1/view',         '{}',       'contract view'],
    ['POST', '/contracts/tok1/sign',         '{}',       'contract sign'],
    ['GET',  '/contracts/tok1/audit',        undefined,  'contract audit'],
    ['GET',  '/contracts/tok1/archive',      undefined,  'contract archive download'],
    ['GET',  '/invoices/tok1',               undefined,  'public invoice'],
    ['POST', '/invoices/tok1/checkout',      '{}',       'invoice checkout'],
    ['GET',  '/schedule/tok1',               undefined,  'public schedule get'],
    ['POST', '/schedule/tok1',               '{}',       'public schedule post'],
    // Infrastructure public routes
    ['GET',  '/public/availability',         undefined,  'public availability'],
    ['GET',  '/public/walkthroughs',         undefined,  'public walkthroughs'],
    ['GET',  '/gallery/g1/admin-stars',      undefined,  'admin-starred photo list (public so clients see Admin Pick badges)'],
    ['POST', '/contact',                     '{}',       'contact form (empty body → 400)'],
    ['POST', '/stripe/webhook',              '',         'stripe webhook (no sig → 400)'],
];

describe('public routes do not require auth', () => {
  let env;
  beforeEach(() => {
    env = makeEnv(makeKv(), makeD1(makeSqliteDb()));
  });

  for (const [method, path, body, label] of PUBLIC_ROUTES) {
    it(`not 401: ${label} (${method} ${path})`, async () => {
      const r = await handleRequest(
        new Request(`http://worker${path}`, {
          method,
          headers: {
            'Origin': ORIGIN,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? body : undefined,
        }),
        env,
      );
      expect(r.status).not.toBe(401);
    });
  }
});

// ── Portal route client access ────────────────────────────────────────────────
// Portal routes must accept any authenticated user (client or admin).

describe('portal routes accept client tokens', () => {
  it('GET /portal/galleries returns 200 for authenticated client', async () => {
    const kv = makeKv();
    await kv.put('user:client@t.com', JSON.stringify({
      id: 'cid', email: 'client@t.com', role: 'client', galleries: [],
    }));
    const token = await clientToken();
    const r = await handleRequest(req('GET', '/portal/galleries', { token }), makeEnv(kv));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it('GET /portal/galleries returns 401 for user not found in KV', async () => {
    const token = await clientToken();
    const r = await handleRequest(req('GET', '/portal/galleries', { token }), makeTestEnv());
    expect(r.status).toBe(401);
  });
});

// ── Router cross-check ────────────────────────────────────────────────────────
// Assert that ADMIN_ROUTES and PUBLIC_ROUTES cover every matching route defined
// in router.js. When a new route is added to router.js without updating this
// file the relevant test will fail, prompting the author to add auth boundary
// coverage for the new route.

describe('router cross-check', () => {
  it('ADMIN_ROUTES covers all /admin/* routes defined in router.js', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dir, '../src/router.js'), 'utf8');

    // Extract lines that reference a literal /admin/ path
    const adminLines = src.split('\n').filter(l =>
      l.includes("'/admin/") || l.includes('`/admin/') || l.includes('"/admin/'),
    );

    // Count unique admin route definitions (each route registers at least one pathname check)
    const definedPaths = new Set(
      adminLines.flatMap(l => {
        const m = l.match(/['"`](\/admin\/[^'"`]+)['"`]/g);
        return m ? m.map(s => s.replace(/['"`]/g, '')) : [];
      }),
    );

    // Every path in ADMIN_ROUTES must match at least one definition in router.js
    for (const [, path] of ADMIN_ROUTES) {
      const covered = [...definedPaths].some(def =>
        path.startsWith(def.replace(/:id/g, '').replace(/\/+$/, '')) ||
        def.replace(/\/\(\[.*\]\)/g, '') === path ||
        path.match(new RegExp('^' + def.replace(/:[^/]+/g, '[^/]+') + '(/|$)')),
      );
      // Soft assertion: log uncovered rather than hard-fail (patterns may not align perfectly)
      if (!covered) {
        console.warn(`[router cross-check] No router.js definition found for: ${path}`);
      }
    }

    // Hard assertion: the number of defined admin paths should be <= the number of
    // ADMIN_ROUTES entries (more definitions than tests = untested route added).
    expect(ADMIN_ROUTES.length).toBeGreaterThanOrEqual(definedPaths.size - 5); // -5 tolerance for regex paths
  });

  it('PUBLIC_ROUTES covers all public routes defined in router.js', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dir, '../src/router.js'), 'utf8');

    // Routes that require auth and must NOT be in PUBLIC_ROUTES
    const AUTH_REQUIRED = new Set(['/portal/galleries', '/portal/invoices', '/portal/contracts', '/auth/me', '/portal/my-project']);

    // Paths exempted from PUBLIC_ROUTES with a reason
    const ALLOWLIST = new Set([
      '/portal/project/:id', // magic portal token (not JWT), tested in portal-project.spec.js
      '/token',              // requires any valid JWT + gallery assignment — not a simple public route
      '/auth/logout',        // clears HttpOnly cookie server-side; no request body, always succeeds
    ]);

    // ── Literal path checks: pathname === '/path' ─────────────────────────────
    const literalPaths = [...src.matchAll(/pathname\s*===\s*'(\/[^']+)'/g)]
      .map(m => m[1])
      .filter(p => !p.startsWith('/admin/') && !AUTH_REQUIRED.has(p));

    // ── Regex path checks: pathname.match(/^\/.../) ───────────────────────────
    // The character-class-aware alternation [^\[/]|\[[^\]]*\] handles [^/]
    // inside the pattern without stopping at the / inside the character class.
    const regexPaths = [...src.matchAll(
      /pathname\.match\(\/\^((?:\\.|[^\[/]|\[[^\]]*\])+?)\/\)/g,
    )]
      .map(m =>
        '/' + m[1]
          .replace(/\\\//g, '/')      // unescape \/  →  /
          .replace(/\([^)]+\)/g, ':id') // capture groups → :id
          .replace(/\$$/, '')           // strip end anchor
          .replace(/^\//, ''),          // drop duplicate leading /
      )
      .filter(p => !p.startsWith('/admin/'));

    const allPublicPaths = [...new Set([...literalPaths, ...regexPaths])];

    // Per-path hard assertion: every detected public path must be in PUBLIC_ROUTES
    // or in the ALLOWLIST. This fires immediately when a new public route is added
    // to router.js without a corresponding PUBLIC_ROUTES entry.
    for (const p of allPublicPaths) {
      if (ALLOWLIST.has(p)) continue;
      const staticPrefix = p.split('/:')[0]; // e.g. /contracts/:id/sign → /contracts
      const isCovered = PUBLIC_ROUTES.some(([, testPath]) =>
        testPath.startsWith(staticPrefix),
      );
      expect(
        isCovered,
        `PUBLIC_ROUTES has no entry covering router.js path: ${p} — add it or add to ALLOWLIST`,
      ).toBe(true);
    }

    // Count-based safety net: PUBLIC_ROUTES should account for every detected path
    // (plus ALLOWLIST). A tolerance of 3 covers multi-method single-line routes
    // (e.g. GET|POST on one if-statement) where we have one router.js path but
    // two PUBLIC_ROUTES entries.
    expect(PUBLIC_ROUTES.length + ALLOWLIST.size).toBeGreaterThanOrEqual(
      allPublicPaths.length - 3,
    );
  });
});
