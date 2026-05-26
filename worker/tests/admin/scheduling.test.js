import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  handlePublicAvailability, handleAdminAvailability, handleAdminBlockedDates,
  handleAdminProjectScheduleLinks, handlePublicSchedule,
} from '../../src/admin/scheduling.js';
import { createJWT } from '../../src/jwt.js';

const SECRET = 'test-jwt-secret-at-least-32-chars!!';

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

async function adminReq(method, body) {
  const token = await createJWT({ sub: 'a@t.com', id: 'aid', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  return new Request('http://t', {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function clientReq(method) {
  const token = await createJWT({ sub: 'c@t.com', role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  return new Request('http://t', { method, headers: { Authorization: `Bearer ${token}` } });
}

const env = (db) => ({ JWT_SECRET: SECRET, DB: db ?? makeDb() });

afterEach(() => { vi.unstubAllGlobals(); });

describe('handlePublicAvailability', () => {
  it('returns empty structure when DB not configured', async () => {
    const r = await handlePublicAvailability({});
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.windows).toEqual([]);
    expect(b.blocked_dates).toEqual([]);
  });
  it('returns availability windows and blocked dates from DB', async () => {
    const db = makeDb();
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ day_of_week: 1 }] })
      .mockResolvedValueOnce({ results: [{ date: '2025-06-01' }] });
    const r = await handlePublicAvailability({ DB: db });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.windows.length).toBe(1);
    expect(b.blocked_dates).toContain('2025-06-01');
  });
});

describe('handleAdminAvailability', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminAvailability(new Request('http://t'), 'GET', env())).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminAvailability(await clientReq('GET'), 'GET', env())).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminAvailability(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET })).status).toBe(503);
  });
  it('returns availability on GET', async () => {
    const db = makeDb();
    db.prepare().all
      .mockResolvedValueOnce({ results: [{ day_of_week: 0 }] })
      .mockResolvedValueOnce({ results: [] });
    const r = await handleAdminAvailability(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET, DB: db });
    expect(r.status).toBe(200);
  });
  it('400 on PUT when windows is not an array', async () => {
    const r = await handleAdminAvailability(await adminReq('PUT', { windows: 'not-array' }), 'PUT', env());
    expect(r.status).toBe(400);
  });
  it('200 on PUT with valid windows array', async () => {
    const r = await handleAdminAvailability(
      await adminReq('PUT', { windows: [{ day_of_week: 1, start_time: '09:00', end_time: '17:00', active: true }] }),
      'PUT', env(),
    );
    expect(r.status).toBe(200);
  });
  it('200 on PUT with active: false window (uses 0 fallback)', async () => {
    const r = await handleAdminAvailability(
      await adminReq('PUT', { windows: [{ day_of_week: 6, start_time: '10:00', end_time: '14:00', active: false }] }),
      'PUT', env(),
    );
    expect(r.status).toBe(200);
  });
});

describe('handleAdminBlockedDates', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminBlockedDates(new Request('http://t'), 'GET', env())).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminBlockedDates(await clientReq('GET'), 'GET', env())).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminBlockedDates(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET })).status).toBe(503);
  });
  it('returns blocked dates on GET', async () => {
    const r = await handleAdminBlockedDates(await adminReq('GET'), 'GET', env(makeDb([{ id: 'bd1', date: '2025-07-04' }])));
    expect(r.status).toBe(200);
  });
  it('400 on POST when date missing', async () => {
    const r = await handleAdminBlockedDates(await adminReq('POST', {}), 'POST', env());
    expect(r.status).toBe(400);
  });
  it('201 on POST with date', async () => {
    const r = await handleAdminBlockedDates(await adminReq('POST', { date: '2025-07-04', reason: 'Holiday' }), 'POST', env());
    expect(r.status).toBe(201);
    expect((await r.json()).date).toBe('2025-07-04');
  });
  it('201 on POST without reason uses empty string fallback', async () => {
    const r = await handleAdminBlockedDates(await adminReq('POST', { date: '2025-08-01' }), 'POST', env());
    expect(r.status).toBe(201);
    expect((await r.json()).reason).toBe('');
  });
  it('200 on DELETE', async () => {
    const r = await handleAdminBlockedDates(await adminReq('DELETE'), 'DELETE', env(), 'bd1');
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
});

describe('handleAdminProjectScheduleLinks', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminProjectScheduleLinks(new Request('http://t'), 'GET', env(), 'p1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminProjectScheduleLinks(await clientReq('GET'), 'GET', env(), 'p1')).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminProjectScheduleLinks(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET }, 'p1')).status).toBe(503);
  });
  it('returns schedule links on GET', async () => {
    const r = await handleAdminProjectScheduleLinks(await adminReq('GET'), 'GET', env(makeDb([{ id: 'sl1' }])), 'p1');
    expect(r.status).toBe(200);
  });
  it('404 on POST when project not found', async () => {
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [] });
    const r = await handleAdminProjectScheduleLinks(
      await adminReq('POST', { link_type: 'discovery-call' }),
      'POST', { JWT_SECRET: SECRET, DB: db }, 'nope',
    );
    expect(r.status).toBe(404);
  });
  it('201 creates schedule link', async () => {
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com' };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [proj] });
    const r = await handleAdminProjectScheduleLinks(
      await adminReq('POST', { link_type: 'shoot', duration_mins: 60 }),
      'POST', { JWT_SECRET: SECRET, DB: db }, 'p1',
    );
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.link_type).toBe('shoot');
    expect(b.public_url).toContain('/schedule.html#');
  });
  it('201 creates link with default link_type and duration when not provided', async () => {
    const proj = { id: 'p2', client_name: 'Bob', client_email: 'b@t.com' };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [proj] });
    const r = await handleAdminProjectScheduleLinks(
      await adminReq('POST', {}),
      'POST', { JWT_SECRET: SECRET, DB: db }, 'p2',
    );
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.link_type).toBe('discovery-call');
    expect(b.duration_mins).toBe(30);
  });
  it('201 creates discovery-call link and sends email', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const proj = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com' };
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [proj] });
    const r = await handleAdminProjectScheduleLinks(
      await adminReq('POST', { link_type: 'discovery-call', duration_mins: 30 }),
      'POST', { JWT_SECRET: SECRET, DB: db, RESEND_API_KEY: 'key' }, 'p1',
    );
    expect(r.status).toBe(201);
    expect((await r.json()).link_type).toBe('discovery-call');
  });
});

describe('handlePublicSchedule', () => {
  it('503 when DB missing', async () => {
    expect((await handlePublicSchedule(new Request('http://t'), 'GET', {}, 'tok')).status).toBe(503);
  });
  it('404 when link not found', async () => {
    const r = await handlePublicSchedule(new Request('http://t'), 'GET', { DB: makeDb([]) }, 'tok');
    expect(r.status).toBe(404);
  });
  it('returns available slots on GET', async () => {
    const link = { id: 'sl1', link_type: 'discovery-call', duration_mins: 30, client_name: 'Alice', booked_at: '', booked_slot: '' };
    const db   = makeDb([link]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [link] })
      .mockResolvedValueOnce({ results: [{ day_of_week: 1, start_time: '09:00', end_time: '17:00', active: 1 }] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] });
    const r = await handlePublicSchedule(new Request('http://t'), 'GET', { DB: db }, 'tok');
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.link_type).toBe('discovery-call');
    expect(Array.isArray(b.available_slots)).toBe(true);
  });
  it('returns already-booked link with empty slots', async () => {
    const link = { id: 'sl1', link_type: 'discovery-call', duration_mins: 30, client_name: 'Alice', booked_at: '2025-01-01', booked_slot: '2025-01-01T10:00:00' };
    const db   = makeDb([link]);
    db.prepare().all.mockResolvedValue({ results: [link] });
    const r = await handlePublicSchedule(new Request('http://t'), 'GET', { DB: db }, 'tok');
    expect(r.status).toBe(200);
    expect((await r.json()).booked).toBe(true);
  });
  it('409 on POST when already booked', async () => {
    const link = { id: 'sl1', link_type: 'discovery-call', duration_mins: 30, client_name: 'Alice', booked_at: '2025-01-01', client_email: 'a@t.com' };
    const db   = makeDb([link]);
    db.prepare().all.mockResolvedValue({ results: [link] });
    const r = await handlePublicSchedule(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ slot: '2025-01-01T10:00:00' }) }),
      'POST', { DB: db }, 'tok',
    );
    expect(r.status).toBe(409);
  });
  it('400 on POST when slot missing', async () => {
    const link = { id: 'sl1', link_type: 'discovery-call', duration_mins: 30, client_name: 'Alice', booked_at: '', client_email: 'a@t.com' };
    const db   = makeDb([link]);
    db.prepare().all.mockResolvedValue({ results: [link] });
    const r = await handlePublicSchedule(
      new Request('http://t', { method: 'POST', body: JSON.stringify({}) }),
      'POST', { DB: db }, 'tok',
    );
    expect(r.status).toBe(400);
  });
  it('400 on POST with invalid JSON body', async () => {
    const link = { id: 'sl1', link_type: 'discovery-call', duration_mins: 30, client_name: 'Alice', booked_at: '', client_email: 'a@t.com' };
    const db   = makeDb([link]);
    db.prepare().all.mockResolvedValue({ results: [link] });
    const r = await handlePublicSchedule(
      new Request('http://t', { method: 'POST', body: 'not-json' }),
      'POST', { DB: db }, 'tok',
    );
    expect(r.status).toBe(400);
  });
  it('200 on valid POST books the slot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const link = { id: 'sl1', link_type: 'discovery-call', duration_mins: 30, client_name: 'Alice', booked_at: '', client_email: 'a@t.com', project_id: 'p1' };
    const db   = makeDb([link]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [link] });
    const r = await handlePublicSchedule(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ slot: '2025-06-15T10:00:00', notes: 'test' }) }),
      'POST', { DB: db, RESEND_API_KEY: 'key' }, 'tok',
    );
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
  it('200 on POST for shoot type updates shoot_date', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const link = { id: 'sl2', link_type: 'shoot', duration_mins: 60, client_name: 'Bob', booked_at: '', client_email: 'b@t.com', project_id: 'p2' };
    const db   = makeDb([link]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [link] });
    const r = await handlePublicSchedule(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ slot: '2025-07-01T09:00:00' }) }),
      'POST', { DB: db }, 'tok',
    );
    expect(r.status).toBe(200);
  });
  it('200 on POST with notes and RESEND_API_KEY sends ICS emails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const link = { id: 'sl3', link_type: 'discovery-call', duration_mins: 0, client_name: 'Carol', booked_at: '', client_email: 'c@t.com', project_id: 'p3' };
    const db   = makeDb([link]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [link] });
    const r = await handlePublicSchedule(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ slot: '2025-08-01T14:00:00', notes: 'Call notes here' }) }),
      'POST', { DB: db, RESEND_API_KEY: 'key' }, 'tok',
    );
    expect(r.status).toBe(200);
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });
  it('200 on GET for available slots with blocked date in range', async () => {
    const link = { id: 'sl4', link_type: 'discovery-call', duration_mins: 30, client_name: 'Alice', booked_at: '', booked_slot: '' };
    const db   = makeDb([link]);
    const stmt = db.prepare();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const blockedDate = tomorrow.toISOString().slice(0, 10);
    stmt.all
      .mockResolvedValueOnce({ results: [link] })
      .mockResolvedValueOnce({ results: [{ day_of_week: tomorrow.getDay(), start_time: '09:00', end_time: '17:00', active: 1 }] })
      .mockResolvedValueOnce({ results: [{ date: blockedDate }] })
      .mockResolvedValueOnce({ results: [] });
    const r = await handlePublicSchedule(new Request('http://t'), 'GET', { DB: db }, 'tok');
    expect(r.status).toBe(200);
  });
  it('200 on GET with duration_mins 0 falls back to 30', async () => {
    const link = { id: 'sl6', link_type: 'discovery-call', duration_mins: 0, client_name: 'Eve', booked_at: '', booked_slot: '' };
    const db   = makeDb([link]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [link] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] });
    const r = await handlePublicSchedule(new Request('http://t'), 'GET', { DB: db }, 'tok');
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.booked).toBe(false);
  });
  it('200 on GET with attendeeEmail missing in ICS generation path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const link = { id: 'sl5', link_type: 'shoot', duration_mins: 60, client_name: 'Dave', booked_at: '', client_email: '', project_id: 'p5' };
    const db   = makeDb([link]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [link] });
    const r = await handlePublicSchedule(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ slot: '2025-09-01T10:00:00' }) }),
      'POST', { DB: db, RESEND_API_KEY: 'key' }, 'tok',
    );
    expect(r.status).toBe(200);
  });
});
