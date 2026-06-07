import { ALLOWED_ORIGIN } from '../constants.js';
import { jsonResponse, authRequired, forbidden, escHtml } from '../utils.js';
import { getAuth } from '../jwt.js';

function buildContractSnapshot(contract, adminSignature, adminSignatureType, adminSignedAt) {
  const renderSig = (sig, type) => {
    if (!sig) return '<em style="color:#999">Not provided</em>';
    if (type === 'drawn') return `<img src="${escHtml(sig)}" alt="Signature" style="max-height:70px;display:block">`;
    return `<span style="font-family:Georgia,serif;font-size:1.8em;font-style:italic">${escHtml(sig)}</span>`;
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escHtml(contract.title)} — Fully Executed</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Georgia,serif;color:#1C1C1C;max-width:760px;margin:0 auto;padding:48px 32px;line-height:1.65;font-size:15px}
h1{font-size:24px;margin-bottom:6px}
h2{font-size:16px;margin:28px 0 10px;border-bottom:1px solid #ddd;padding-bottom:6px}
p{margin-bottom:12px}
ul{margin:0 0 12px 20px}
li{margin-bottom:4px}
.badge{display:inline-block;background:#2A5C45;color:#fff;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:.08em;padding:3px 12px;border-radius:20px;margin-bottom:20px}
.meta{font-family:sans-serif;font-size:13px;color:#555;border:1px solid #E8DDD0;border-radius:4px;padding:14px 18px;margin-bottom:32px}
.meta p{margin-bottom:4px}
.sigs{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:40px;padding-top:28px;border-top:2px solid #2A5C45}
.sig-label{font-family:sans-serif;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#666;margin-bottom:10px}
.sig-name{font-family:sans-serif;font-size:13px;margin-top:10px;font-weight:600}
.sig-date{font-family:sans-serif;font-size:12px;color:#666;margin-top:2px}
.audit{margin-top:40px;background:#F4F1EC;padding:20px 24px;border-radius:4px;font-family:sans-serif;font-size:12px}
.audit h3{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}
.hash{word-break:break-all;color:#555;font-family:monospace;font-size:11px;margin-top:6px}
</style>
</head>
<body>
<div class="badge">FULLY EXECUTED CONTRACT</div>
<h1>${escHtml(contract.title)}</h1>
<div class="meta">
<p><strong>Client:</strong> ${escHtml(contract.client_name)} &lt;${escHtml(contract.client_email)}&gt;</p>
<p><strong>Client signed:</strong> ${escHtml(contract.client_signed_at)}</p>
<p><strong>Fully executed:</strong> ${escHtml(adminSignedAt)}</p>
</div>
<div class="contract-body">${contract.body}</div>
<div class="sigs">
<div>
<div class="sig-label">Client Signature</div>
${renderSig(contract.client_signature, contract.client_signature_type)}
<div class="sig-name">${escHtml(contract.client_name)}</div>
<div class="sig-date">${escHtml(contract.client_signed_at)}</div>
</div>
<div>
<div class="sig-label">Photographer Signature</div>
${renderSig(adminSignature, adminSignatureType)}
<div class="sig-name">Coastal Travel Company</div>
<div class="sig-date">${escHtml(adminSignedAt)}</div>
</div>
</div>
<div class="audit">
<h3>Document Integrity</h3>
<p>SHA-256 hash of the contract body at time of signing:</p>
<div class="hash">${escHtml(contract.body_hash)}</div>
</div>
</body>
</html>`;
}

export async function handleAdminContractTemplates(request, method, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM contract_templates ORDER BY created_at DESC').all();
    return jsonResponse(results);
  }
  if (method === 'POST') {
    const { name, collection_type, body: tmplBody } = await request.json();
    if (!name) return jsonResponse({ error: 'name required' }, 400);
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO contract_templates (id,name,collection_type,body,created_at,updated_at) VALUES (?,?,?,?,?,?)'
    ).bind(id, name, collection_type || '', tmplBody || '', now, now).run();
    return jsonResponse({ id, name, collection_type: collection_type || '', body: tmplBody || '', created_at: now, updated_at: now }, 201);
  }
}

export async function handleAdminContractTemplateById(request, method, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (method === 'PUT') {
    const body    = await request.json();
    const allowed = ['name', 'collection_type', 'body'];
    const sets = [], vals = [];
    for (const f of allowed) {
      if (body[f] !== undefined) { sets.push(f + ' = ?'); vals.push(body[f]); }
    }
    if (!sets.length) return jsonResponse({ error: 'No fields to update' }, 400);
    const now = new Date().toISOString();
    sets.push('updated_at = ?'); vals.push(now); vals.push(id);
    await env.DB.prepare('UPDATE contract_templates SET ' + sets.join(', ') + ' WHERE id = ?').bind(...vals).run();
    const { results } = await env.DB.prepare('SELECT * FROM contract_templates WHERE id = ?').bind(id).all();
    return jsonResponse(results[0] || { error: 'Not found' });
  }
  if (method === 'DELETE') {
    await env.DB.prepare('DELETE FROM contract_templates WHERE id = ?').bind(id).run();
    return jsonResponse({ ok: true });
  }
}

export async function handleAdminProjectContracts(request, method, env, projectId, p) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM contracts WHERE project_id = ? ORDER BY created_at DESC'
    ).bind(projectId).all();
    return jsonResponse(results);
  }
  if (method === 'POST') {
    const body = await request.json();
    const { title, contract_body, merge_fields, template_id } = body;
    if (!title || !contract_body) return jsonResponse({ error: 'title and contract_body required' }, 400);
    const { results: projR } = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).all();
    const project = projR[0];
    if (!project) return jsonResponse({ error: 'Project not found' }, 404);
    const id           = crypto.randomUUID();
    const signingToken = crypto.randomUUID();
    const now          = new Date().toISOString();
    const bodyHashBuf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(contract_body));
    const bodyHash     = Array.from(new Uint8Array(bodyHashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    const publicUrl    = ALLOWED_ORIGIN + '/contract.html#' + signingToken;
    await env.DB.prepare(
      'INSERT INTO contracts (id,project_id,template_id,title,body,merge_fields,signing_token,status,client_name,client_email,client_signature,client_signature_type,client_signed_at,client_ip,client_ua,admin_signature,admin_signature_type,admin_signed_at,admin_ip,admin_ua,body_hash,sent_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(id, projectId, template_id || '', title, contract_body, JSON.stringify(merge_fields || {}), signingToken, 'sent',
      project.client_name || '', project.client_email || '', '', '', '', '', '', '', '', '', '', '', bodyHash, now, now, now).run();
    await env.DB.prepare(
      'INSERT INTO project_documents (id,project_id,type,title,url,created_at) VALUES (?,?,?,?,?,?)'
    ).bind(crypto.randomUUID(), projectId, 'contract', title, publicUrl, now).run();
    await env.DB.prepare('UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?').bind('Contract Sent', now, projectId).run();
    await env.DB.prepare(
      'INSERT INTO contract_signing_events (id,contract_id,event_type,actor,actor_email,ip_address,user_agent,body_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(crypto.randomUUID(), id, 'created', 'admin', p?.email || '', '', '', bodyHash, now).run();
    if (env.RESEND_API_KEY && project.client_email) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>',
          to: [project.client_email],
          subject: 'Your contract is ready to sign — Coastal Travel Company',
          html: `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(project.client_name)},</p><p style="font-family:sans-serif;font-size:15px">Your contract <strong>${escHtml(title)}</strong> is ready for your review and signature.</p><p style="font-family:sans-serif;font-size:15px"><a href="${publicUrl}" style="color:#2A5C45;font-weight:600">Review &amp; Sign Contract →</a></p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`,
        }),
      }).catch(() => {});
    }
    return jsonResponse({ id, project_id: projectId, title, signing_token: signingToken, status: 'sent', public_url: publicUrl, client_name: project.client_name || '', client_email: project.client_email || '', created_at: now, updated_at: now }, 201);
  }
}

export async function handleAdminProjectContractCountersign(request, env, projectId, contractId, p) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { signature, signature_type } = await request.json();
  if (!signature || !signature_type) return jsonResponse({ error: 'signature and signature_type required' }, 400);
  const { results: cR } = await env.DB.prepare('SELECT * FROM contracts WHERE id = ? AND project_id = ?').bind(contractId, projectId).all();
  const contract = cR[0];
  if (!contract) return jsonResponse({ error: 'Contract not found' }, 404);
  if (contract.status !== 'client_signed') return jsonResponse({ error: 'Client must sign before countersigning' }, 400);
  const now = new Date().toISOString();
  const ip  = '';
  const ua  = '';
  await env.DB.prepare(
    'UPDATE contracts SET admin_signature=?,admin_signature_type=?,admin_signed_at=?,admin_ip=?,admin_ua=?,status=?,updated_at=? WHERE id=?'
  ).bind(signature, signature_type, now, ip, ua, 'fully_executed', now, contractId).run();
  await env.DB.prepare('UPDATE projects SET stage=?,updated_at=? WHERE id=?').bind('Contract Signed', now, projectId).run();
  await env.DB.prepare(
    'INSERT INTO contract_signing_events (id,contract_id,event_type,actor,actor_email,ip_address,user_agent,body_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).bind(crypto.randomUUID(), contractId, 'admin_countersigned', 'admin', p?.email || '', ip, ua, contract.body_hash || '', now).run();
  const contractUrl = ALLOWED_ORIGIN + '/contract.html#' + contract.signing_token;
  const { results: projR2 } = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(projectId).all();
  const project2 = projR2[0];
  if (env.RESEND_API_KEY && project2?.client_email) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>',
        to: [project2.client_email],
        subject: 'Your contract is fully executed — Coastal Travel Company',
        html: `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(project2.client_name)},</p><p style="font-family:sans-serif;font-size:15px">Your contract <strong>${escHtml(contract.title)}</strong> has been signed by both parties. You can view and download your copy at any time:</p><p style="font-family:sans-serif;font-size:15px"><a href="${contractUrl}" style="color:#2A5C45;font-weight:600">View Fully Executed Contract →</a></p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`,
      }),
    }).catch(() => {});
  }
  if (env.ASSETS) {
    const r2Key = `contracts/${contractId}/signed.html`;
    const html  = buildContractSnapshot(contract, signature, signature_type, now);
    await env.ASSETS.put(r2Key, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
    await env.DB.prepare('UPDATE contracts SET r2_key=? WHERE id=?').bind(r2Key, contractId).run();
  }
  const { results: updated } = await env.DB.prepare('SELECT * FROM contracts WHERE id=?').bind(contractId).all();
  return jsonResponse(updated[0]);
}

export async function handlePublicContractArchive(request, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(
    'SELECT id, r2_key, status FROM contracts WHERE signing_token = ?'
  ).bind(token).all();
  const contract = results[0];
  if (!contract) return jsonResponse({ error: 'Contract not found' }, 404);
  if (contract.status !== 'fully_executed') return jsonResponse({ error: 'Contract is not yet fully executed' }, 400);
  if (!contract.r2_key || !env.ASSETS) return jsonResponse({ error: 'Archive not available' }, 404);
  const obj = await env.ASSETS.get(contract.r2_key);
  if (!obj) return jsonResponse({ error: 'Archive file not found' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="signed-contract-${escHtml(contract.id)}.html"`,
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Cache-Control': 'private, no-store',
    },
  });
}

export async function handlePublicContractGet(request, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(
    'SELECT id,title,body,status,merge_fields,client_name,client_email,client_signed_at,client_signature_type,admin_signed_at,admin_signature_type,created_at FROM contracts WHERE signing_token = ?'
  ).bind(token).all();
  if (!results[0]) return jsonResponse({ error: 'Contract not found' }, 404);
  return jsonResponse(results[0]);
}

export async function handlePublicContractView(request, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare('SELECT id,body_hash FROM contracts WHERE signing_token = ?').bind(token).all();
  if (!results[0]) return jsonResponse({ error: 'Not found' }, 404);
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO contract_signing_events (id,contract_id,event_type,actor,actor_email,ip_address,user_agent,body_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).bind(crypto.randomUUID(), results[0].id, 'viewed', 'client', '', '', '', results[0].body_hash || '', now).run();
  return jsonResponse({ ok: true });
}

export async function handlePublicContractSign(request, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const body = await request.json();
  const { signature, signature_type } = body;
  if (!signature || !signature_type) return jsonResponse({ error: 'signature and signature_type required' }, 400);
  const { results: cR } = await env.DB.prepare('SELECT * FROM contracts WHERE signing_token = ?').bind(token).all();
  const contract = cR[0];
  if (!contract) return jsonResponse({ error: 'Contract not found' }, 404);
  if (contract.status !== 'sent') return jsonResponse({ error: 'Contract already signed' }, 400);
  const now = new Date().toISOString();
  const ip  = request.headers.get('CF-Connecting-IP') || '';
  const ua  = request.headers.get('User-Agent') || '';
  await env.DB.prepare(
    'UPDATE contracts SET client_signature=?,client_signature_type=?,client_signed_at=?,client_ip=?,client_ua=?,status=?,updated_at=? WHERE signing_token=?'
  ).bind(signature, signature_type, now, ip, ua, 'client_signed', now, token).run();
  await env.DB.prepare(
    'INSERT INTO contract_signing_events (id,contract_id,event_type,actor,actor_email,ip_address,user_agent,body_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).bind(crypto.randomUUID(), contract.id, 'client_signed', 'client', contract.client_email || '', ip, ua, contract.body_hash || '', now).run();
  if (env.RESEND_API_KEY) {
    const contractUrl = ALLOWED_ORIGIN + '/contract.html#' + token;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>',
        to: ['thecoastaltravelcompany@gmail.com'],
        subject: `Contract signed — ${escHtml(contract.client_name)} — ${escHtml(contract.title)}`,
        html: `<p style="font-family:sans-serif;font-size:15px">${escHtml(contract.client_name)} has signed the contract "${escHtml(contract.title)}".</p><p style="font-family:sans-serif;font-size:15px"><a href="${contractUrl}" style="color:#2A5C45;font-weight:600">Review &amp; Countersign →</a></p>`,
      }),
    }).catch(() => {});
  }
  return jsonResponse({ ok: true, status: 'client_signed', client_signed_at: now });
}

export async function handlePublicContractAudit(request, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results: cR } = await env.DB.prepare('SELECT id,status FROM contracts WHERE signing_token = ?').bind(token).all();
  if (!cR[0]) return jsonResponse({ error: 'Contract not found' }, 404);
  const { results: events } = await env.DB.prepare(
    'SELECT * FROM contract_signing_events WHERE contract_id = ? ORDER BY created_at ASC'
  ).bind(cR[0].id).all();
  return jsonResponse({ contract_id: cR[0].id, status: cR[0].status, events });
}
