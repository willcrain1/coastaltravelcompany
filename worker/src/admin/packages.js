import { ALLOWED_ORIGIN } from '../constants.js';
import { jsonResponse, authRequired, forbidden } from '../utils.js';
import { getAuth } from '../jwt.js';

export async function handleAdminPackages(request, method, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

  if (method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM service_packages ORDER BY created_at DESC'
    ).all();
    return jsonResponse(results);
  }

  if (method === 'POST') {
    const body = await request.json();
    const { name, description, inclusions, hero_photo, base_price, addons } = body;
    if (!name) return jsonResponse({ error: 'name required' }, 400);
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO service_packages (id,name,description,inclusions,hero_photo,base_price,addons,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(id, name, description||'', inclusions||'', hero_photo||'', Number(base_price)||0, JSON.stringify(addons||[]), now, now).run();
    return jsonResponse({ id, name, description:description||'', inclusions:inclusions||'', hero_photo:hero_photo||'', base_price:Number(base_price)||0, addons:JSON.stringify(addons||[]), created_at:now, updated_at:now }, 201);
  }
}

export async function handleAdminPackageById(request, method, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

  if (method === 'PUT') {
    const body    = await request.json();
    const allowed = ['name','description','inclusions','hero_photo','base_price','addons'];
    const sets = [], vals = [];
    for (const f of allowed) {
      if (body[f] !== undefined) {
        sets.push(f + ' = ?');
        vals.push(f === 'addons' ? JSON.stringify(body[f] || []) : (f === 'base_price' ? Number(body[f]) || 0 : body[f]));
      }
    }
    if (!sets.length) return jsonResponse({ error: 'No fields to update' }, 400);
    const now = new Date().toISOString();
    sets.push('updated_at = ?'); vals.push(now); vals.push(id);
    await env.DB.prepare('UPDATE service_packages SET ' + sets.join(', ') + ' WHERE id = ?').bind(...vals).run();
    const { results } = await env.DB.prepare('SELECT * FROM service_packages WHERE id = ?').bind(id).all();
    return jsonResponse(results[0] || { error: 'Not found' });
  }

  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM service_packages WHERE id = ?').bind(id).run();
    return jsonResponse({ ok: true });
  }
}

export async function handlePublicProposal(request, env, id) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).all();
  const proposal = results[0];
  if (!proposal) return jsonResponse({ error: 'Proposal not found' }, 404);
  await env.DB.prepare(
    "UPDATE proposals SET view_count = view_count + 1, opened_at = CASE WHEN opened_at = '' THEN ? ELSE opened_at END, updated_at = ? WHERE id = ?"
  ).bind(now, now, id).run();
  proposal.view_count = Number(proposal.view_count || 0) + 1;
  proposal.opened_at  = proposal.opened_at || now;
  const projectRows = await env.DB.prepare(
    'SELECT id,client_name,client_email,property,location,collection,shoot_date,stage FROM projects WHERE id = ?'
  ).bind(proposal.project_id).all();
  const packageIds = JSON.parse(proposal.package_ids || '[]');
  let packages = [];
  if (packageIds.length) {
    const placeholders = packageIds.map(() => '?').join(',');
    const packageRows  = await env.DB.prepare(
      `SELECT * FROM service_packages WHERE id IN (${placeholders})`
    ).bind(...packageIds).all();
    packages = packageIds.map(pid => packageRows.results.find(pkg => pkg.id === pid)).filter(Boolean);
  }
  return jsonResponse({ proposal, project: projectRows.results[0] || null, packages });
}

export async function handlePublicProposalAnalytics(request, env, id) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  let seconds = 0;
  try {
    const body = await request.text();
    seconds = Math.max(0, Math.min(3600, Number(JSON.parse(body || '{}').seconds) || 0));
  } catch {}
  if (seconds > 0) {
    await env.DB.prepare(
      'UPDATE proposals SET time_spent_seconds = time_spent_seconds + ?, updated_at = ? WHERE id = ?'
    ).bind(Math.round(seconds), new Date().toISOString(), id).run();
  }
  return jsonResponse({ ok: true });
}

export async function handlePublicProposalSelect(request, env, id) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const body      = await request.json();
  const packageId = body.package_id || '';
  const addons    = Array.isArray(body.addons) ? body.addons : [];
  const { results } = await env.DB.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).all();
  const proposal = results[0];
  if (!proposal) return jsonResponse({ error: 'Proposal not found' }, 404);
  const allowed = JSON.parse(proposal.package_ids || '[]');
  if (!allowed.includes(packageId)) return jsonResponse({ error: 'Select a package from this proposal' }, 400);
  const now = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE proposals SET status = ?, selected_package_id = ?, selected_addons = ?, selected_at = ?, updated_at = ? WHERE id = ?'
  ).bind('approved', packageId, JSON.stringify(addons), now, now, id).run();
  await env.DB.prepare('UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?').bind('Contract Sent', now, proposal.project_id).run();
  return jsonResponse({ ok: true, status: 'approved', selected_package_id: packageId, selected_addons: addons, selected_at: now });
}

export async function handleAdminProjectProposals(request, method, env, projectId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

  if (method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM proposals WHERE project_id = ? ORDER BY created_at DESC'
    ).bind(projectId).all();
    return jsonResponse(results);
  }

  if (method === 'POST') {
    const { package_ids, cover_note, expires_at } = await request.json();
    const ids = Array.isArray(package_ids) ? package_ids.slice(0, 3) : [];
    if (!ids.length) return jsonResponse({ error: 'Select at least one package' }, 400);
    const id        = crypto.randomUUID();
    const now       = new Date().toISOString();
    const publicUrl = `${ALLOWED_ORIGIN}/proposal.html#${id}`;
    await env.DB.prepare(
      'INSERT INTO proposals (id,project_id,cover_note,expires_at,package_ids,status,public_url,opened_at,view_count,time_spent_seconds,selected_package_id,selected_addons,selected_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(id, projectId, cover_note||'', expires_at||'', JSON.stringify(ids), 'sent', publicUrl, '', 0, 0, '', '[]', '', now, now).run();
    await env.DB.prepare(
      'INSERT INTO project_documents (id,project_id,type,title,url,created_at) VALUES (?,?,?,?,?,?)'
    ).bind(crypto.randomUUID(), projectId, 'proposal', 'Proposal ' + new Date(now).toLocaleDateString('en-US'), publicUrl, now).run();
    await env.DB.prepare('UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?').bind('Proposal Sent', now, projectId).run();
    return jsonResponse({ id, project_id:projectId, cover_note:cover_note||'', expires_at:expires_at||'', package_ids:JSON.stringify(ids), status:'sent', public_url:publicUrl, opened_at:'', view_count:0, time_spent_seconds:0, selected_package_id:'', selected_addons:'[]', selected_at:'', created_at:now, updated_at:now }, 201);
  }
}
