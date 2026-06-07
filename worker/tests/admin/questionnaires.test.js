import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  handleAdminQuestionnaireSets, handleAdminQuestionnaireSetById,
  handleAdminProjectQuestionnaires, handlePublicQuestionnaire,
} from '../../src/admin/questionnaires.js';
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

describe('handleAdminQuestionnaireSets', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminQuestionnaireSets(new Request('http://t'), 'GET', env())).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminQuestionnaireSets(await clientReq('GET'), 'GET', env())).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminQuestionnaireSets(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET })).status).toBe(503);
  });
  it('returns sets on GET', async () => {
    const r = await handleAdminQuestionnaireSets(await adminReq('GET'), 'GET', env(makeDb([{ id: 'qs1' }])));
    expect(r.status).toBe(200);
  });
  it('400 on POST when name missing', async () => {
    const r = await handleAdminQuestionnaireSets(await adminReq('POST', { name: '' }), 'POST', env());
    expect(r.status).toBe(400);
  });
  it('201 on POST with name', async () => {
    const r = await handleAdminQuestionnaireSets(
      await adminReq('POST', { name: 'Pre-Booking', questions: [{ label: 'Q1' }] }),
      'POST', env(),
    );
    expect(r.status).toBe(201);
    expect((await r.json()).name).toBe('Pre-Booking');
  });
  it('201 on POST with non-array questions defaults to []', async () => {
    const r = await handleAdminQuestionnaireSets(
      await adminReq('POST', { name: 'Set2' }),
      'POST', env(),
    );
    expect(r.status).toBe(201);
  });
});

describe('handleAdminQuestionnaireSetById', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminQuestionnaireSetById(new Request('http://t', { method: 'PUT', body: '{}' }), 'PUT', env(), 'qs1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminQuestionnaireSetById(await clientReq('PUT'), 'PUT', env(), 'qs1')).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminQuestionnaireSetById(await adminReq('PUT', { name: 'x' }), 'PUT', { JWT_SECRET: SECRET }, 'qs1')).status).toBe(503);
  });
  it('200 on DELETE', async () => {
    const r = await handleAdminQuestionnaireSetById(await adminReq('DELETE'), 'DELETE', env(), 'qs1');
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });
});

describe('handleAdminProjectQuestionnaires', () => {
  it('401 when unauthenticated', async () => {
    expect((await handleAdminProjectQuestionnaires(new Request('http://t'), 'GET', env(), 'p1')).status).toBe(401);
  });
  it('403 for non-admin', async () => {
    expect((await handleAdminProjectQuestionnaires(await clientReq('GET'), 'GET', env(), 'p1')).status).toBe(403);
  });
  it('503 when DB missing', async () => {
    expect((await handleAdminProjectQuestionnaires(await adminReq('GET'), 'GET', { JWT_SECRET: SECRET }, 'p1')).status).toBe(503);
  });
  it('returns instances on GET', async () => {
    const r = await handleAdminProjectQuestionnaires(await adminReq('GET'), 'GET', env(makeDb([{ id: 'qi1' }])), 'p1');
    expect(r.status).toBe(200);
  });
  it('400 on POST when questionnaire_set_id missing', async () => {
    const r = await handleAdminProjectQuestionnaires(await adminReq('POST', {}), 'POST', env(), 'p1');
    expect(r.status).toBe(400);
  });
  it('404 on POST when questionnaire set not found', async () => {
    const db   = makeDb([]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [] });
    const r = await handleAdminProjectQuestionnaires(
      await adminReq('POST', { set_id: 'qs1' }),
      'POST', { JWT_SECRET: SECRET, DB: db }, 'p1',
    );
    expect(r.status).toBe(404);
  });
  it('201 on POST with valid set', async () => {
    const qset   = { id: 'qs1', name: 'Set', phase: 'pre', questions: '[]' };
    const proj   = { id: 'p1', client_name: 'Alice', client_email: 'a@t.com' };
    const db     = makeDb();
    const stmt   = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [qset] })
      .mockResolvedValueOnce({ results: [proj] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const r = await handleAdminProjectQuestionnaires(
      await adminReq('POST', { set_id: 'qs1' }),
      'POST', { JWT_SECRET: SECRET, DB: db, RESEND_API_KEY: 'key' }, 'p1',
    );
    expect(r.status).toBe(201);
  });
  it('404 on POST when set found but project not found', async () => {
    const db   = makeDb();
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [{ id: 'qs1', name: 'Set', phase: 'pre', questions: '[]' }] })
      .mockResolvedValueOnce({ results: [] });
    const r = await handleAdminProjectQuestionnaires(
      await adminReq('POST', { set_id: 'qs1' }),
      'POST', { JWT_SECRET: SECRET, DB: db }, 'missing-project',
    );
    expect(r.status).toBe(404);
    expect((await r.json()).error).toContain('Project');
  });
});

describe('handlePublicQuestionnaire', () => {
  it('503 when DB missing', async () => {
    expect((await handlePublicQuestionnaire(new Request('http://t'), 'GET', {}, 'tok')).status).toBe(503);
  });
  it('404 when token not found', async () => {
    const r = await handlePublicQuestionnaire(new Request('http://t'), 'GET', { DB: makeDb([]) }, 'tok');
    expect(r.status).toBe(404);
  });
  it('returns questionnaire data on GET', async () => {
    const instance = { id: 'qi1', set_id: 'qs1', project_id: 'p1', status: 'sent', questions_snapshot: '[]' };
    const db = makeDb([instance]);
    const stmt = db.prepare();
    stmt.all
      .mockResolvedValueOnce({ results: [instance] })
      .mockResolvedValueOnce({ results: [{ id: 'p1', client_name: 'Alice' }] });
    const r = await handlePublicQuestionnaire(new Request('http://t'), 'GET', { DB: db }, 'tok');
    expect(r.status).toBe(200);
  });
  it('200 on POST submits answers', async () => {
    const instance = { id: 'qi1', set_id: 'qs1', project_id: 'p1', status: 'sent', questions_snapshot: '[]' };
    const db = makeDb([instance]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [instance] });
    const r = await handlePublicQuestionnaire(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ answers: [{ question: 'q', answer: 'a' }] }) }),
      'POST', { DB: db }, 'tok',
    );
    expect(r.status).toBe(200);
  });
  it('409 on POST when questionnaire already completed', async () => {
    const instance = { id: 'qi1', set_id: 'qs1', project_id: 'p1', status: 'completed', questions_snapshot: '[]' };
    const db = makeDb([instance]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [instance] });
    const r = await handlePublicQuestionnaire(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ answers: [] }) }),
      'POST', { DB: db }, 'tok',
    );
    expect(r.status).toBe(409);
  });
  it('400 on POST with invalid JSON body', async () => {
    const instance = { id: 'qi1', set_id: 'qs1', project_id: 'p1', status: 'sent', questions_snapshot: '[]' };
    const db = makeDb([instance]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [instance] });
    const r = await handlePublicQuestionnaire(
      new Request('http://t', { method: 'POST', body: 'not-valid-json' }),
      'POST', { DB: db }, 'tok',
    );
    expect(r.status).toBe(400);
  });
  it('200 on POST sends admin notification when RESEND_API_KEY set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const instance = { id: 'qi2', set_id: 'qs1', project_id: 'p1', status: 'sent', questions_snapshot: '[]', client_name: 'Alice', set_name: 'Pre-Trip' };
    const db = makeDb([instance]);
    const stmt = db.prepare();
    stmt.all.mockResolvedValue({ results: [instance] });
    const r = await handlePublicQuestionnaire(
      new Request('http://t', { method: 'POST', body: JSON.stringify({ answers: [] }) }),
      'POST', { DB: db, RESEND_API_KEY: 'key' }, 'tok',
    );
    expect(r.status).toBe(200);
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });
});
