import { jsonResponse, authRequired, forbidden } from '../utils.js';
import { getAuth } from '../jwt.js';

export async function handleAdminProjects(request, method, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

  if (method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM projects ORDER BY updated_at DESC'
    ).all();
    return jsonResponse(results);
  }

  if (method === 'POST') {
    const body = await request.json();
    const { client_name, client_email, property, location, collection, shoot_date, message, source } = body;
    if (!client_name || !client_email) return jsonResponse({ error: 'client_name and client_email required' }, 400);
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO projects (id,stage,client_name,client_email,property,location,collection,shoot_date,message,source,labels,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(id, 'Inquiry', client_name, client_email, property||'', location||'', collection||'', shoot_date||'', message||'', source||'manual', '', now, now).run();
    return jsonResponse({ id, stage:'Inquiry', client_name, client_email, property:property||'', location:location||'', collection:collection||'', shoot_date:shoot_date||'', message:message||'', source:source||'manual', labels:'', created_at:now, updated_at:now }, 201);
  }
}

export async function handleAdminProjectById(request, method, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

  if (method === 'PUT') {
    const body    = await request.json();
    const allowed = ['stage','client_name','client_email','property','location','collection','shoot_date','labels'];
    const sets = [], vals = [];
    for (const f of allowed) {
      if (body[f] !== undefined) { sets.push(f + ' = ?'); vals.push(body[f]); }
    }
    if (!sets.length) return jsonResponse({ error: 'No fields to update' }, 400);
    const now = new Date().toISOString();
    sets.push('updated_at = ?'); vals.push(now); vals.push(id);
    await env.DB.prepare('UPDATE projects SET ' + sets.join(', ') + ' WHERE id = ?').bind(...vals).run();
    const { results } = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).all();
    return jsonResponse(results[0] || { error: 'Not found' });
  }

  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM project_notes WHERE project_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM project_documents WHERE project_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM proposals WHERE project_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
    return jsonResponse({ ok: true });
  }
}

export async function handleAdminProjectNotes(request, method, env, projectId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

  if (method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at DESC'
    ).bind(projectId).all();
    return jsonResponse(results);
  }

  if (method === 'POST') {
    const { type, content, due_date } = await request.json();
    if (!content) return jsonResponse({ error: 'content required' }, 400);
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO project_notes (id,project_id,type,content,due_date,created_at) VALUES (?,?,?,?,?,?)'
    ).bind(id, projectId, type||'note', content, due_date||'', now).run();
    await env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now, projectId).run();
    return jsonResponse({ id, project_id:projectId, type:type||'note', content, due_date:due_date||'', created_at:now }, 201);
  }
}

export async function handleAdminProjectDocuments(request, method, env, projectId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

  if (method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM project_documents WHERE project_id = ? ORDER BY created_at DESC'
    ).bind(projectId).all();
    return jsonResponse(results);
  }

  if (method === 'POST') {
    const { type, title, url } = await request.json();
    if (!title || !url) return jsonResponse({ error: 'title and url required' }, 400);
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO project_documents (id,project_id,type,title,url,created_at) VALUES (?,?,?,?,?,?)'
    ).bind(id, projectId, type||'proposal', title, url, now).run();
    await env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now, projectId).run();
    return jsonResponse({ id, project_id:projectId, type:type||'proposal', title, url, created_at:now }, 201);
  }
}
