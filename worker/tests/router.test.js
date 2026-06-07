import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { handleRequest } from '../src/router.js';
import { createJWT } from '../src/jwt.js';
import { initCors } from '../src/constants.js';

const SECRET  = 'test-jwt-secret-at-least-32-chars!!';
const ORIGIN  = 'https://coastaltravelcompany.com';

function makeDb(rows = []) {
  const stmt = {
    bind:  vi.fn().mockReturnThis(),
    all:   vi.fn().mockResolvedValue({ results: rows }),
    run:   vi.fn().mockResolvedValue({}),
    first: vi.fn().mockResolvedValue(rows[0] ?? null),
  };
  stmt.bind.mockReturnValue(stmt);
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

function makeKv() {
  const store = new Map();
  return {
    get:    async (k)    => store.get(k) ?? null,
    put:    async (k, v) => { store.set(k, v); },
    delete: async (k)    => { store.delete(k); },
  };
}

const baseEnv = (overrides = {}) => ({
  JWT_SECRET: SECRET,
  KV:         makeKv(),
  DB:         makeDb(),
  ...overrides,
});

function req(method, pathname, opts = {}) {
  const { origin, body, headers = {} } = opts;
  const h = { ...headers };
  if (origin !== false) h['Origin'] = origin ?? ORIGIN;
  if (body)             h['Content-Type'] = 'application/json';
  return new Request(`http://worker${pathname}`, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function adminReq(method, pathname, body) {
  const token = await createJWT({ sub: 'a@t.com', id: 'aid', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  return req(method, pathname, { body, headers: { Authorization: `Bearer ${token}` } });
}

async function clientReq(method, pathname, opts = {}) {
  const token = await createJWT({ sub: 'c@t.com', role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  return req(method, pathname, { ...opts, headers: { Authorization: `Bearer ${token}` } });
}

beforeEach(() => { initCors(ORIGIN); });
afterEach(() => { vi.unstubAllGlobals(); initCors(ORIGIN); });

describe('handleRequest – infrastructure', () => {
  it('OPTIONS returns 204 with CORS headers', async () => {
    const r = await handleRequest(req('OPTIONS', '/auth/login'), baseEnv());
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('403 when origin does not match', async () => {
    const r = await handleRequest(req('GET', '/auth/me', { origin: 'https://evil.com' }), baseEnv());
    expect(r.status).toBe(403);
  });

  it('allows request matching via Referer when no Origin header', async () => {
    const kv  = makeKv();
    await kv.put('setup_done', '1');
    const r   = await handleRequest(
      new Request(`http://worker/auth/setup-status`, {
        method: 'GET',
        headers: { Referer: `${ORIGIN}/some-page` },
      }),
      baseEnv({ KV: kv }),
    );
    expect(r.status).toBe(200);
  });
});

describe('handleRequest – auth routes', () => {
  it('GET /auth/setup-status', async () => {
    const r = await handleRequest(req('GET', '/auth/setup-status'), baseEnv());
    expect(r.status).toBe(200);
  });

  it('POST /auth/register returns 400 when email missing', async () => {
    const r = await handleRequest(req('POST', '/auth/register', { body: {} }), baseEnv());
    expect(r.status).toBe(400);
  });

  it('POST /auth/login returns 400 when email missing', async () => {
    const r = await handleRequest(req('POST', '/auth/login', { body: {} }), baseEnv());
    expect(r.status).toBe(400);
  });

  it('GET /auth/me returns 401 when no token', async () => {
    const r = await handleRequest(req('GET', '/auth/me'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /auth/verify returns 400 when no token param', async () => {
    const r = await handleRequest(req('GET', '/auth/verify'), baseEnv());
    expect(r.status).toBe(400);
  });

  it('POST /auth/resend-verify returns 400 when email missing', async () => {
    const r = await handleRequest(req('POST', '/auth/resend-verify', { body: {} }), baseEnv());
    expect(r.status).toBe(400);
  });

  it('POST /auth/reset-request returns 400 when email missing', async () => {
    const r = await handleRequest(req('POST', '/auth/reset-request', { body: {} }), baseEnv());
    expect(r.status).toBe(400);
  });

  it('POST /auth/reset-confirm returns 400 when fields missing', async () => {
    const r = await handleRequest(req('POST', '/auth/reset-confirm', { body: {} }), baseEnv());
    expect(r.status).toBe(400);
  });

  it('POST /auth/setup returns 400 when email missing', async () => {
    const r = await handleRequest(req('POST', '/auth/setup', { body: {} }), baseEnv());
    expect(r.status).toBe(400);
  });

  it('POST /auth/google returns 503 when KV missing', async () => {
    const r = await handleRequest(req('POST', '/auth/google', { body: { credential: 'tok' } }), { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });
});

describe('handleRequest – proposal routes', () => {
  it('GET /proposals/:id returns 503 when DB missing', async () => {
    const r = await handleRequest(req('GET', '/proposals/p1'), { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });

  it('POST /proposals/:id/analytics returns 200', async () => {
    const r = await handleRequest(
      req('POST', '/proposals/p1/analytics', { body: { seconds: 0 } }),
      baseEnv(),
    );
    expect(r.status).toBe(200);
  });

  it('POST /proposals/:id/select returns 503 when DB missing', async () => {
    const r = await handleRequest(
      req('POST', '/proposals/p1/select', { body: {} }),
      { JWT_SECRET: SECRET },
    );
    expect(r.status).toBe(503);
  });
});

describe('handleRequest – admin gallery routes', () => {
  it('GET /admin/galleries returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('GET', '/admin/galleries'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('PUT /admin/galleries/:id returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('PUT', '/admin/galleries/g1', { body: {} }), baseEnv());
    expect(r.status).toBe(401);
  });

  it('DELETE /admin/galleries/:id returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('DELETE', '/admin/galleries/g1'), baseEnv());
    expect(r.status).toBe(401);
  });
});

describe('handleRequest – admin user routes', () => {
  it('GET /admin/users returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('GET', '/admin/users'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('POST /admin/users returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('POST', '/admin/users', { body: {} }), baseEnv());
    expect(r.status).toBe(401);
  });

  it('PATCH /admin/users/:id/role returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('PATCH', '/admin/users/u1/role', { body: {} }), baseEnv());
    expect(r.status).toBe(401);
  });

  it('PUT /admin/users/:id returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('PUT', '/admin/users/u1', { body: {} }), baseEnv());
    expect(r.status).toBe(401);
  });

  it('DELETE /admin/users/:id returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('DELETE', '/admin/users/u1'), baseEnv());
    expect(r.status).toBe(401);
  });
});

describe('handleRequest – admin package routes', () => {
  it('GET /admin/packages returns 401', async () => {
    const r = await handleRequest(req('GET', '/admin/packages'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('PUT /admin/packages/:id returns 401', async () => {
    const r = await handleRequest(req('PUT', '/admin/packages/pkg1', { body: {} }), baseEnv());
    expect(r.status).toBe(401);
  });
});

describe('handleRequest – admin questionnaire routes', () => {
  it('GET /admin/questionnaires returns 401', async () => {
    const r = await handleRequest(req('GET', '/admin/questionnaires'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('PUT /admin/questionnaires/:id returns 401', async () => {
    const r = await handleRequest(req('PUT', '/admin/questionnaires/qs1', { body: {} }), baseEnv());
    expect(r.status).toBe(401);
  });
});

describe('handleRequest – admin project routes', () => {
  it('GET /admin/projects returns 401', async () => {
    const r = await handleRequest(req('GET', '/admin/projects'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /admin/projects/:id returns 401', async () => {
    const r = await handleRequest(req('GET', '/admin/projects/p1'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /admin/projects/:id/notes returns 401', async () => {
    const r = await handleRequest(req('GET', '/admin/projects/p1/notes'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /admin/projects/:id/documents returns 401', async () => {
    const r = await handleRequest(req('GET', '/admin/projects/p1/documents'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /admin/projects/:id/proposals returns 401', async () => {
    const r = await handleRequest(req('GET', '/admin/projects/p1/proposals'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /admin/projects/:id/questionnaires returns 401', async () => {
    const r = await handleRequest(req('GET', '/admin/projects/p1/questionnaires'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('POST /admin/projects/:id/portal-link returns 401', async () => {
    const r = await handleRequest(req('POST', '/admin/projects/p1/portal-link'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /admin/projects/:id/messages returns 401', async () => {
    const r = await handleRequest(req('GET', '/admin/projects/p1/messages'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /admin/projects/:id/schedule-links returns 401', async () => {
    const r = await handleRequest(req('GET', '/admin/projects/p1/schedule-links'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /admin/projects/:id/contracts returns 401', async () => {
    const r = await handleRequest(req('GET', '/admin/projects/p1/contracts'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /admin/projects/:id/contracts returns 403 for non-admin', async () => {
    const r = await handleRequest(await clientReq('GET', '/admin/projects/p1/contracts'), baseEnv());
    expect(r.status).toBe(403);
  });

  it('GET /admin/projects/:id/contracts calls handler for admin (503 without DB)', async () => {
    const r = await handleRequest(await adminReq('GET', '/admin/projects/p1/contracts'), { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });

  it('POST /admin/projects/:id/contracts/:cid/countersign returns 401', async () => {
    const r = await handleRequest(req('POST', '/admin/projects/p1/contracts/c1/countersign', { body: {} }), baseEnv());
    expect(r.status).toBe(401);
  });

  it('POST /admin/projects/:id/contracts/:cid/countersign returns 403 for non-admin', async () => {
    const r = await handleRequest(await clientReq('POST', '/admin/projects/p1/contracts/c1/countersign', { body: {} }), baseEnv());
    expect(r.status).toBe(403);
  });

  it('POST /admin/projects/:id/contracts/:cid/countersign calls handler for admin (503 without DB)', async () => {
    const r = await handleRequest(
      await adminReq('POST', '/admin/projects/p1/contracts/c1/countersign', { signature: 'x', signature_type: 'typed' }),
      { JWT_SECRET: SECRET },
    );
    expect(r.status).toBe(503);
  });

  it('GET /admin/projects/:id/invoices returns 401', async () => {
    const r = await handleRequest(req('GET', '/admin/projects/p1/invoices'), baseEnv());
    expect(r.status).toBe(401);
  });
});

describe('handleRequest – portal routes', () => {
  it('GET /portal/galleries returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('GET', '/portal/galleries'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /portal/invoices returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('GET', '/portal/invoices'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /portal/project/:token returns 503 when DB missing', async () => {
    const r = await handleRequest(req('GET', '/portal/project/tok'), { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });
});

describe('handleRequest – public questionnaire', () => {
  it('GET /questionnaire/:token returns 503 when DB missing', async () => {
    const r = await handleRequest(req('GET', '/questionnaire/tok'), { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });
  it('POST /questionnaire/:token returns 503 when DB missing', async () => {
    const r = await handleRequest(req('POST', '/questionnaire/tok', { body: {} }), { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });
});

describe('handleRequest – scheduling routes', () => {
  it('GET /public/availability returns 200 without DB', async () => {
    const r = await handleRequest(req('GET', '/public/availability'), { JWT_SECRET: SECRET });
    expect(r.status).toBe(200);
  });

  it('GET /admin/availability returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('GET', '/admin/availability'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /admin/blocked-dates returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('GET', '/admin/blocked-dates'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('DELETE /admin/blocked-dates/:id returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('DELETE', '/admin/blocked-dates/bd1'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /schedule/:token returns 503 when DB missing', async () => {
    const r = await handleRequest(req('GET', '/schedule/tok'), { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });
});

describe('handleRequest – automation routes', () => {
  it('GET /admin/automations returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('GET', '/admin/automations'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /admin/automation-logs returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('GET', '/admin/automation-logs'), baseEnv());
    expect(r.status).toBe(401);
  });
});

describe('handleRequest – contract routes', () => {
  it('GET /admin/contract-templates returns 401', async () => {
    const r = await handleRequest(req('GET', '/admin/contract-templates'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('PUT /admin/contract-templates/:id returns 401', async () => {
    const r = await handleRequest(req('PUT', '/admin/contract-templates/ct1', { body: {} }), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /contracts/:token returns 503 when DB missing', async () => {
    const r = await handleRequest(req('GET', '/contracts/tok'), { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });

  it('POST /contracts/:token/view returns 503 when DB missing', async () => {
    const r = await handleRequest(req('POST', '/contracts/tok/view'), { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });

  it('POST /contracts/:token/sign returns 503 when DB missing', async () => {
    const r = await handleRequest(req('POST', '/contracts/tok/sign', { body: {} }), { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });

  it('GET /contracts/:token/audit returns 503 when DB missing', async () => {
    const r = await handleRequest(req('GET', '/contracts/tok/audit'), { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });
});

describe('handleRequest – invoice routes', () => {
  it('POST /admin/invoices/:id/send returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('POST', '/admin/invoices/inv1/send'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /admin/invoices/:id returns 401 when unauthenticated', async () => {
    const r = await handleRequest(req('GET', '/admin/invoices/inv1'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('GET /invoices/:token returns 503 when DB missing', async () => {
    const r = await handleRequest(req('GET', '/invoices/tok'), { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });

  it('POST /invoices/:token/checkout returns 503 when DB missing', async () => {
    const r = await handleRequest(req('POST', '/invoices/tok/checkout'), { JWT_SECRET: SECRET });
    expect(r.status).toBe(503);
  });

  it('POST /stripe/webhook returns 200 when no config', async () => {
    const r = await handleRequest(req('POST', '/stripe/webhook', { body: {} }), { JWT_SECRET: SECRET });
    expect(r.status).toBe(200);
  });
});

describe('handleRequest – walkthrough routes', () => {
  it('GET /public/walkthroughs returns 200 with DB', async () => {
    const r = await handleRequest(req('GET', '/public/walkthroughs'), baseEnv());
    expect(r.status).toBe(200);
  });

  it('GET /admin/walkthroughs returns 401', async () => {
    const r = await handleRequest(req('GET', '/admin/walkthroughs'), baseEnv());
    expect(r.status).toBe(401);
  });

  it('PUT /admin/walkthroughs/:id returns 401', async () => {
    const r = await handleRequest(req('PUT', '/admin/walkthroughs/w1', { body: {} }), baseEnv());
    expect(r.status).toBe(401);
  });
});

describe('handleRequest – token exchange + contact', () => {
  it('POST /token returns 400 when no body passphrase', async () => {
    const kv = makeKv();
    await kv.put('gallery:test', JSON.stringify({ id: 'test', passphrase: 'vCsa5XjJH' }));
    const r  = await handleRequest(
      req('POST', '/token', { body: {} }),
      baseEnv({ KV: kv }),
    );
    expect([400, 401, 500]).toContain(r.status);
  });

  it('POST /contact returns 400 when fields missing', async () => {
    const r = await handleRequest(req('POST', '/contact', { body: {} }), baseEnv());
    expect(r.status).toBe(400);
  });
});

describe('handleRequest – NAS proxy fallthrough', () => {
  it('proxies GET with sid to NAS', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('data', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ));
    const kv = makeKv();
    await kv.put('tok:test-sid', 'passphrase123');
    const r  = await handleRequest(
      new Request('http://worker/photo?sid=test-sid&api=SYNO.Foto.Browse.Item', {
        headers: { Origin: ORIGIN },
      }),
      baseEnv({ KV: kv }),
    );
    expect([200, 400, 401, 502]).toContain(r.status);
  });
});
