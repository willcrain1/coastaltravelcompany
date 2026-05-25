import { jsonResponse, authRequired, forbidden, escHtml } from './utils.js';
import { getAuth } from './jwt.js';
import { getGallery } from './kv.js';
import { CONTACT_TO } from './constants.js';

// KV key: adminstars:<galleryId> → JSON array of photo ID strings

export async function handleAdminStarsGet(request, env, galleryId) {
  const raw = await env.KV.get('adminstars:' + galleryId);
  const stars = raw ? JSON.parse(raw) : [];
  return jsonResponse({ stars });
}

export async function handleAdminStarToggle(request, env, galleryId, photoId) {
  const auth = await getAuth(request, env);
  if (!auth) return authRequired();
  if (auth.role !== 'admin') return forbidden();

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  const starred = body.starred === true;

  const raw = await env.KV.get('adminstars:' + galleryId);
  let stars = raw ? JSON.parse(raw) : [];

  const id = String(photoId);
  if (starred) {
    if (!stars.includes(id)) stars.push(id);
  } else {
    stars = stars.filter(s => s !== id);
  }

  await env.KV.put('adminstars:' + galleryId, JSON.stringify(stars));
  return jsonResponse({ stars });
}

export async function handleSubmitSelections(request, env, galleryId) {
  const auth = await getAuth(request, env);
  if (!auth) return authRequired();

  const gallery = await getGallery(galleryId, env.KV);
  if (!gallery) return jsonResponse({ error: 'Gallery not found' }, 404);

  const rlKey = 'selrl:' + galleryId + ':' + auth.sub;
  const countStr = await env.KV.get(rlKey);
  const count = countStr ? parseInt(countStr, 10) : 0;
  if (count >= 5) return jsonResponse({ error: 'Too many submissions. Please try again later.' }, 429);
  await env.KV.put(rlKey, String(count + 1), { expirationTtl: 3600 });

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const selections = Array.isArray(body.selections) ? body.selections.slice(0, 500) : [];
  const note = String(body.note || '').trim().slice(0, 1000);

  if (selections.length === 0) return jsonResponse({ error: 'No photos selected.' }, 400);

  const listHtml = selections.map((s, i) =>
    `<tr style="background:${i % 2 ? '#f9f9f9' : '#fff'}">` +
    `<td style="padding:7px 14px;font-family:monospace;font-size:12px;color:#1C1C1C">${escHtml(String(s))}</td>` +
    `</tr>`
  ).join('');

  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#1C1C1C;max-width:600px;margin:0 auto;padding:24px">
<h2 style="color:#2A5C45;margin-bottom:4px">Client Selections — ${escHtml(gallery.eventName || 'Gallery')}</h2>
<p style="color:#666;margin-bottom:20px;font-size:13px">${escHtml(gallery.clientName || '')} submitted ${selections.length} photo selection${selections.length !== 1 ? 's' : ''}.</p>
${note ? `<div style="background:#f4f1ec;padding:14px 16px;margin-bottom:20px;border-left:3px solid #2A5C45"><strong style="font-size:12px;letter-spacing:0.05em">Note from client:</strong><br><span style="font-size:13px;line-height:1.7">${escHtml(note)}</span></div>` : ''}
<table style="border-collapse:collapse;width:100%;border:1px solid #eee">
  <thead><tr><th style="padding:10px 14px;background:#2A5C45;color:#fff;text-align:left;font-size:11px;letter-spacing:0.08em;font-weight:600">SELECTED PHOTOS (${selections.length})</th></tr></thead>
  <tbody>${listHtml}</tbody>
</table>
</body></html>`;

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>',
      to: [CONTACT_TO],
      subject: `Client Selections: ${gallery.eventName} — ${selections.length} photo${selections.length !== 1 ? 's' : ''}`,
      html,
    }),
  });

  if (!resendRes.ok) return jsonResponse({ error: 'Failed to send. Please try again.' }, 502);
  return jsonResponse({ ok: true });
}
