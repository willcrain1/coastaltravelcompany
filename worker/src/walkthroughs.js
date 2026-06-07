import { jsonResponse, authRequired, forbidden } from './utils.js';
import { getAuth } from './jwt.js';

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Public ───────────────────────────────────────────────────────────────────

export async function handlePublicWalkthroughs(request, env) {
  const rows = await env.DB.prepare(
    `SELECT id, title, property_name, location, description,
            embed_url, thumbnail_url, collection, sort_order
     FROM walkthroughs
     WHERE published = 1
     ORDER BY sort_order ASC, created_at DESC`
  ).all();
  return jsonResponse(rows.results || []);
}

// ── Admin CRUD ────────────────────────────────────────────────────────────────

export async function handleAdminWalkthroughs(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();

  if (request.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT * FROM walkthroughs ORDER BY sort_order ASC, created_at DESC`
    ).all();
    return jsonResponse(rows.results || []);
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const id = newId();
    await env.DB.prepare(
      `INSERT INTO walkthroughs
         (id, title, property_name, location, description, embed_url,
          thumbnail_url, collection, sort_order, published)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      body.title || '',
      body.property_name || '',
      body.location || null,
      body.description || null,
      body.embed_url || '',
      body.thumbnail_url || null,
      body.collection || null,
      body.sort_order ?? 0,
      body.published ? 1 : 0
    ).run();
    const row = await env.DB.prepare(`SELECT * FROM walkthroughs WHERE id = ?`).bind(id).first();
    return jsonResponse(row, 201);
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

export async function handleAdminWalkthroughById(request, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();

  if (request.method === 'PUT') {
    const existing = await env.DB.prepare(`SELECT id FROM walkthroughs WHERE id = ?`).bind(id).first();
    if (!existing) return jsonResponse({ error: 'Not found' }, 404);
    const body = await request.json();
    await env.DB.prepare(
      `UPDATE walkthroughs
       SET title = ?, property_name = ?, location = ?, description = ?,
           embed_url = ?, thumbnail_url = ?, collection = ?,
           sort_order = ?, published = ?
       WHERE id = ?`
    ).bind(
      body.title || '',
      body.property_name || '',
      body.location || null,
      body.description || null,
      body.embed_url || '',
      body.thumbnail_url || null,
      body.collection || null,
      body.sort_order ?? 0,
      body.published ? 1 : 0,
      id
    ).run();
    const row = await env.DB.prepare(`SELECT * FROM walkthroughs WHERE id = ?`).bind(id).first();
    return jsonResponse(row);
  }

  if (request.method === 'DELETE') {
    await env.DB.prepare(`DELETE FROM walkthroughs WHERE id = ?`).bind(id).run();
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}
