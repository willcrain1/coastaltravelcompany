import { describe, it, expect, vi } from 'vitest';
import { handleAnalyticsEvent, handleAdminAnalyticsSummary } from '../src/analytics.js';
import { createJWT } from '../src/jwt.js';

const SECRET = 'test-jwt-secret-at-least-32-chars!!';

function makeDb(rows = [], firstRow = null) {
  const stmt = {
    bind:  vi.fn().mockReturnThis(),
    all:   vi.fn().mockResolvedValue({ results: rows }),
    run:   vi.fn().mockResolvedValue({}),
    first: vi.fn().mockResolvedValue(firstRow),
  };
  stmt.bind.mockReturnValue(stmt);
  return { prepare: vi.fn().mockReturnValue(stmt), _stmt: stmt };
}

function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get:    async (k)      => store.get(k) ?? null,
    put:    async (k, v)   => { store.set(k, v); },
    delete: async (k)      => { store.delete(k); },
    _store: store,
  };
}

function eventReq(body) {
  return new Request('http://t/analytics/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function adminReq(url = 'http://t/admin/analytics/summary') {
  const token = await createJWT({ sub: 'a@t.com', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  return new Request(url, { headers: { Authorization: `Bearer ${token}` } });
}
async function clientReq(url = 'http://t/admin/analytics/summary') {
  const token = await createJWT({ sub: 'c@t.com', role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  return new Request(url, { headers: { Authorization: `Bearer ${token}` } });
}

const validBody = {
  session_id: 'sess-123',
  event_type: 'pageview',
  page: '/index.html',
};

describe('handleAnalyticsEvent', () => {
  it('400 on invalid JSON body', async () => {
    const req = new Request('http://t/analytics/event', { method: 'POST', body: '{not json' });
    const r = await handleAnalyticsEvent(req, { DB: makeDb(), KV: makeKv() });
    expect(r.status).toBe(400);
  });

  it('400 when session_id is missing', async () => {
    const r = await handleAnalyticsEvent(eventReq({ ...validBody, session_id: '' }), { DB: makeDb(), KV: makeKv() });
    expect(r.status).toBe(400);
  });

  it('400 when event_type is not in the allowed set', async () => {
    const r = await handleAnalyticsEvent(eventReq({ ...validBody, event_type: 'bogus' }), { DB: makeDb(), KV: makeKv() });
    expect(r.status).toBe(400);
  });

  it('400 when page is missing', async () => {
    const r = await handleAnalyticsEvent(eventReq({ ...validBody, page: '' }), { DB: makeDb(), KV: makeKv() });
    expect(r.status).toBe(400);
  });

  it('429 when the per-session rate limit is exhausted', async () => {
    const kv = makeKv({ 'analytics_rl:sess-123': '60' });
    const r = await handleAnalyticsEvent(eventReq(validBody), { DB: makeDb(), KV: kv });
    expect(r.status).toBe(429);
  });

  it('201 + inserts a row for a valid event, and increments the rate-limit counter', async () => {
    const db = makeDb();
    const kv = makeKv();
    const r = await handleAnalyticsEvent(eventReq(validBody), { DB: db, KV: kv });
    expect(r.status).toBe(201);
    expect((await r.json()).ok).toBe(true);
    expect(db.prepare).toHaveBeenCalled();
    expect(db._stmt.run).toHaveBeenCalled();
    expect(kv._store.get('analytics_rl:sess-123')).toBe('1');
  });

  it('truncates the referrer down to origin + pathname (strips query/fragment)', async () => {
    const db = makeDb();
    await handleAnalyticsEvent(
      eventReq({ ...validBody, referrer: 'https://example.com/path?token=secret#frag' }),
      { DB: db, KV: makeKv() }
    );
    const bindArgs = db._stmt.bind.mock.calls[0];
    // referrer is the 7th bound parameter (id, session_id, event_type, page, label, value, referrer, ...)
    expect(bindArgs[6]).toBe('https://example.com/path');
  });

  it('drops an unparsable referrer rather than storing raw input', async () => {
    const db = makeDb();
    await handleAnalyticsEvent(
      eventReq({ ...validBody, referrer: 'not a url' }),
      { DB: db, KV: makeKv() }
    );
    const bindArgs = db._stmt.bind.mock.calls[0];
    expect(bindArgs[6]).toBeNull();
  });
});

describe('handleAdminAnalyticsSummary', () => {
  it('401 when not authenticated', async () => {
    const r = await handleAdminAnalyticsSummary(new Request('http://t/admin/analytics/summary'), { DB: makeDb(), JWT_SECRET: SECRET });
    expect(r.status).toBe(401);
  });

  it('403 when authenticated as a non-admin client', async () => {
    const r = await handleAdminAnalyticsSummary(await clientReq(), { DB: makeDb(), JWT_SECRET: SECRET });
    expect(r.status).toBe(403);
  });

  it('200 with aggregated rollups for an admin, defaulting to 30 days', async () => {
    const db = makeDb([{ page: '/index.html', views: 5, sessions: 3 }], { total: 10, sessions: 4 });
    const r = await handleAdminAnalyticsSummary(await adminReq(), { DB: db, JWT_SECRET: SECRET });
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.days).toBe(30);
    expect(json.pageviews).toEqual({ total: 10, sessions: 4 });
    expect(Array.isArray(json.topPages)).toBe(true);
    expect(Array.isArray(json.conversions)).toBe(true);
    expect(Array.isArray(json.scrollDepth)).toBe(true);
    expect(Array.isArray(json.sectionDwell)).toBe(true);
    expect(Array.isArray(json.sources)).toBe(true);
  });

  it('clamps an out-of-range "days" query param back to the 30-day default', async () => {
    const db = makeDb([], { total: 0, sessions: 0 });
    const r = await handleAdminAnalyticsSummary(await adminReq('http://t/admin/analytics/summary?days=9999'), { DB: db, JWT_SECRET: SECRET });
    expect((await r.json()).days).toBe(30);
  });

  it('honors a valid "days" query param', async () => {
    const db = makeDb([], { total: 0, sessions: 0 });
    const r = await handleAdminAnalyticsSummary(await adminReq('http://t/admin/analytics/summary?days=7'), { DB: db, JWT_SECRET: SECRET });
    expect((await r.json()).days).toBe(7);
  });

  it('returns empty arrays / zeroed totals when the DB has no rows', async () => {
    const db = makeDb([], null);
    const r = await handleAdminAnalyticsSummary(await adminReq(), { DB: db, JWT_SECRET: SECRET });
    const json = await r.json();
    expect(json.pageviews).toEqual({ total: 0, sessions: 0 });
    expect(json.topPages).toEqual([]);
  });
});
