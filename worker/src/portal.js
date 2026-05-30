import { ALLOWED_ORIGIN, CONTACT_TO } from './constants.js';
import { jsonResponse, authRequired, forbidden, escHtml } from './utils.js';
import { getAuth } from './jwt.js';
import { getUser, getGallery, stripGallery } from './kv.js';

export async function handlePortalContracts(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.title, c.status, c.client_signed_at, c.admin_signed_at, c.signing_token, c.created_at,
            proj.property, proj.collection
     FROM contracts c
     JOIN projects proj ON c.project_id = proj.id
     WHERE c.client_email = ?
     ORDER BY c.created_at DESC`
  ).bind(p.sub).all();
  return jsonResponse(results.map(r => ({
    ...r,
    public_url: `${ALLOWED_ORIGIN}/contract.html#${r.signing_token}`,
  })));
}

export async function handlePortalGalleries(request, env) {
  const payload = await getAuth(request, env);
  if (!payload) return authRequired();
  const user = await getUser(payload.sub, env.KV);
  if (!user) return authRequired();
  const galleries = (await Promise.all((user.galleries || []).map(id => getGallery(id, env.KV))))
    .filter(Boolean)
    .map(stripGallery);
  return jsonResponse(galleries);
}

export async function handleAdminProjectPortalLink(request, env, projectId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO project_portal_tokens (id,project_id,expires_at,created_at) VALUES (?,?,?,?)')
    .bind(id, projectId, '', now).run();
  return jsonResponse({ id, project_id: projectId, url: `${ALLOWED_ORIGIN}/portal-project.html#${id}`, created_at: now }, 201);
}

export async function handlePublicProjectPortal(request, method, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results: tokenRows } = await env.DB.prepare('SELECT * FROM project_portal_tokens WHERE id = ?').bind(token).all();
  if (!tokenRows.length) return jsonResponse({ error: 'Portal link not found' }, 404);
  const projectId = tokenRows[0].project_id;
  const { results: projRows } = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).all();
  if (!projRows.length) return jsonResponse({ error: 'Project not found' }, 404);
  const proj = projRows[0];

  // If the client has an account, require them to be authenticated as that email
  if (proj.client_email) {
    const clientUser = await getUser(proj.client_email, env.KV);
    if (clientUser) {
      const p = await getAuth(request, env);
      if (!p) return authRequired();
      if (p.sub !== proj.client_email) return forbidden();
    }
  }

  if (method === 'GET') {
    const [docsRes, propsRes, msgsRes, questRes] = await Promise.all([
      env.DB.prepare('SELECT * FROM project_documents WHERE project_id=? ORDER BY created_at DESC').bind(projectId).all(),
      env.DB.prepare('SELECT id,status,public_url,selected_package_id,expires_at,opened_at,selected_at,created_at FROM proposals WHERE project_id=? ORDER BY created_at DESC').bind(projectId).all(),
      env.DB.prepare('SELECT * FROM project_messages WHERE project_id=? ORDER BY created_at ASC').bind(projectId).all(),
      env.DB.prepare('SELECT id,phase,status,sent_at,completed_at FROM questionnaire_instances WHERE project_id=? ORDER BY sent_at DESC').bind(projectId).all(),
    ]);
    return jsonResponse({
      project: { id: proj.id, client_name: proj.client_name, property: proj.property, location: proj.location, collection: proj.collection, shoot_date: proj.shoot_date, stage: proj.stage, created_at: proj.created_at },
      documents: docsRes.results, proposals: propsRes.results,
      messages: msgsRes.results, questionnaires: questRes.results,
    });
  }

  if (method === 'POST') {
    let body; try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid body' }, 400); }
    const { content, sender_name } = body;
    if (!content?.trim()) return jsonResponse({ error: 'content required' }, 400);
    const id   = crypto.randomUUID();
    const now  = new Date().toISOString();
    const name = (sender_name || proj.client_name || 'Client').trim();
    await env.DB.prepare('INSERT INTO project_messages (id,project_id,sender,sender_name,content,created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, projectId, 'client', name, content.trim(), now).run();
    if (env.RESEND_API_KEY) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
          to:      [CONTACT_TO],
          subject: `New portal message — ${proj.client_name}`,
          html:    `<p style="font-family:sans-serif"><strong>${escHtml(name)}</strong> sent a message:</p><blockquote style="font-family:sans-serif;border-left:3px solid #2A5C45;padding-left:12px;margin-left:0">${escHtml(content)}</blockquote><p style="font-family:sans-serif"><a href="${ALLOWED_ORIGIN}/admin/pipeline.html">View in Pipeline →</a></p>`,
        }),
      }).catch(() => {});
    }
    return jsonResponse({ id, project_id: projectId, sender: 'client', sender_name: name, content: content.trim(), created_at: now }, 201);
  }
}

export async function handleAdminProjectMessages(request, method, env, projectId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM project_messages WHERE project_id=? ORDER BY created_at ASC').bind(projectId).all();
    return jsonResponse(results);
  }
  if (method === 'POST') {
    const { content } = await request.json();
    if (!content?.trim()) return jsonResponse({ error: 'content required' }, 400);
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT INTO project_messages (id,project_id,sender,sender_name,content,created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, projectId, 'admin', 'Coastal Travel Company', content.trim(), now).run();
    return jsonResponse({ id, project_id: projectId, sender: 'admin', sender_name: 'Coastal Travel Company', content: content.trim(), created_at: now }, 201);
  }
}
