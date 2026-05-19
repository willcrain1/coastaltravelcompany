import { ALLOWED_ORIGIN, CONTACT_TO } from '../constants.js';
import { jsonResponse, authRequired, forbidden, escHtml } from '../utils.js';
import { getAuth } from '../jwt.js';

export async function handleAdminQuestionnaireSets(request, method, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

  if (method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM questionnaire_sets ORDER BY created_at DESC'
    ).all();
    return jsonResponse(results);
  }

  if (method === 'POST') {
    const { name, phase, questions } = await request.json();
    if (!name) return jsonResponse({ error: 'name required' }, 400);
    const cleanQuestions = Array.isArray(questions) ? questions : [];
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO questionnaire_sets (id,name,phase,questions,created_at,updated_at) VALUES (?,?,?,?,?,?)'
    ).bind(id, name, phase||'pre-booking', JSON.stringify(cleanQuestions), now, now).run();
    return jsonResponse({ id, name, phase:phase||'pre-booking', questions:JSON.stringify(cleanQuestions), created_at:now, updated_at:now }, 201);
  }
}

export async function handleAdminQuestionnaireSetById(request, method, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM questionnaire_sets WHERE id = ?').bind(id).run();
    return jsonResponse({ ok: true });
  }
}

export async function handleAdminProjectQuestionnaires(request, method, env, projectId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

  if (method === 'GET') {
    const { results } = await env.DB.prepare(`
      SELECT qi.*, qs.name AS set_name
      FROM questionnaire_instances qi
      JOIN questionnaire_sets qs ON qi.set_id = qs.id
      WHERE qi.project_id = ? ORDER BY qi.sent_at DESC
    `).bind(projectId).all();
    return jsonResponse(results);
  }

  if (method === 'POST') {
    const { set_id } = await request.json();
    if (!set_id) return jsonResponse({ error: 'set_id required' }, 400);
    const [setRes, projRes] = await Promise.all([
      env.DB.prepare('SELECT * FROM questionnaire_sets WHERE id = ?').bind(set_id).all(),
      env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).all(),
    ]);
    if (!setRes.results.length)  return jsonResponse({ error: 'Questionnaire set not found' }, 404);
    if (!projRes.results.length) return jsonResponse({ error: 'Project not found' }, 404);
    const qs   = setRes.results[0];
    const proj = projRes.results[0];
    const id    = crypto.randomUUID();
    const token = crypto.randomUUID();
    const now   = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO questionnaire_instances (id,project_id,set_id,magic_token,phase,status,sent_at,completed_at,responses) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(id, projectId, set_id, token, qs.phase, 'sent', now, '', '{}').run();
    const url = `${ALLOWED_ORIGIN}/questionnaire.html#${token}`;
    if (env.RESEND_API_KEY && proj.client_email) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
          to:      [proj.client_email],
          subject: qs.name + ' — Coastal Travel Company',
          html:    `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p>
<p style="font-family:sans-serif;font-size:15px">Please take a moment to complete this questionnaire for your upcoming project.</p>
<p><a href="${url}" style="background:#2A5C45;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;font-family:sans-serif">Complete Questionnaire</a></p>
<p style="font-family:sans-serif;font-size:13px;color:#999">Or copy this link: ${url}</p>`,
        }),
      }).catch(() => {});
    }
    return jsonResponse({ id, project_id: projectId, set_id, magic_token: token, phase: qs.phase, status: 'sent', sent_at: now, public_url: url }, 201);
  }
}

export async function handlePublicQuestionnaire(request, method, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(`
    SELECT qi.*, qs.name AS set_name, qs.questions,
           p.client_name, p.property, p.collection
    FROM questionnaire_instances qi
    JOIN questionnaire_sets qs ON qi.set_id = qs.id
    JOIN projects p ON qi.project_id = p.id
    WHERE qi.magic_token = ?
  `).bind(token).all();
  if (!results.length) return jsonResponse({ error: 'Questionnaire not found or link expired' }, 404);
  const qi = results[0];

  if (method === 'GET') {
    return jsonResponse({
      id: qi.id, set_name: qi.set_name, phase: qi.phase, status: qi.status,
      questions: JSON.parse(qi.questions || '[]'),
      client_name: qi.client_name, property: qi.property, collection: qi.collection,
    });
  }

  if (method === 'POST') {
    if (qi.status === 'completed') return jsonResponse({ error: 'Already submitted' }, 409);
    let responses;
    try { responses = await request.json(); } catch { return jsonResponse({ error: 'Invalid body' }, 400); }
    const now = new Date().toISOString();
    await env.DB.prepare('UPDATE questionnaire_instances SET status=?,completed_at=?,responses=? WHERE id=?')
      .bind('completed', now, JSON.stringify(responses), qi.id).run();
    if (env.RESEND_API_KEY) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
          to:      [CONTACT_TO],
          subject: `Questionnaire submitted — ${qi.client_name}`,
          html:    `<p style="font-family:sans-serif"><strong>${escHtml(qi.client_name)}</strong> completed the questionnaire "<em>${escHtml(qi.set_name)}</em>".</p><p style="font-family:sans-serif"><a href="${ALLOWED_ORIGIN}/admin/pipeline.html">View in Pipeline →</a></p>`,
        }),
      }).catch(() => {});
    }
    return jsonResponse({ ok: true, completed_at: now });
  }
}
