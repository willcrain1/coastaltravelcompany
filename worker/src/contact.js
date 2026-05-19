import { CONTACT_RATE_LIMIT, CONTACT_TO } from './constants.js';
import { jsonResponse, escHtml } from './utils.js';

export async function handleContact(request, env) {
  const ip       = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey    = 'contact_rl:' + ip;
  const countStr = await env.KV.get(rlKey);
  const count    = countStr ? parseInt(countStr, 10) : 0;
  if (count >= CONTACT_RATE_LIMIT) {
    return jsonResponse({ error: 'Too many submissions. Please try again later.' }, 429);
  }
  await env.KV.put(rlKey, String(count + 1), { expirationTtl: 3600 });

  const body       = await request.text();
  const p          = new URLSearchParams(body);
  const firstName  = (p.get('first-name') || '').trim();
  const lastName   = (p.get('last-name')  || '').trim();
  const email      = (p.get('email')      || '').trim();
  const property   = (p.get('property')   || '').trim();
  const location   = (p.get('location')   || '').trim();
  const collection = (p.get('collection') || '').trim();
  const timeline   = (p.get('timeline')   || '').trim();
  const message    = (p.get('message')    || '').trim();

  if (!firstName || !email || !message) {
    return jsonResponse({ error: 'Please fill in all required fields.' }, 400);
  }

  const row = (label, val) =>
    `<tr><td style="padding:4px 16px 4px 0;color:#666;white-space:nowrap"><strong>${label}</strong></td>` +
    `<td style="padding:4px 0">${escHtml(val) || '—'}</td></tr>`;

  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#1C1C1C;max-width:600px">
<h2 style="color:#2A5C45">New Inquiry — Coastal Travel Company</h2>
<table style="border-collapse:collapse;margin-bottom:24px">
  ${row('Name',       firstName + (lastName ? ' ' + lastName : ''))}
  ${row('Email',      email)}
  ${row('Property',   property)}
  ${row('Location',   location)}
  ${row('Collection', collection)}
  ${row('Timeline',   timeline)}
</table>
<h3 style="color:#2A5C45;margin-bottom:8px">Message</h3>
<p style="line-height:1.7;white-space:pre-wrap">${escHtml(message)}</p>
</body></html>`;

  const resendRes = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:     'Coastal Travel Company <noreply@coastaltravelcompany.com>',
      to:       [CONTACT_TO],
      reply_to: email,
      subject:  `Inquiry: ${firstName}${lastName ? ' ' + lastName : ''}${property ? ' — ' + property : ''}`,
      html,
    }),
  });

  if (!resendRes.ok) {
    return jsonResponse({ error: 'Failed to send. Please try again or email us directly.' }, 502);
  }

  if (env.DB) {
    try {
      const pid        = crypto.randomUUID();
      const now        = new Date().toISOString();
      const clientName = firstName + (lastName ? ' ' + lastName : '');
      await env.DB.prepare(
        'INSERT INTO projects (id,stage,client_name,client_email,property,location,collection,shoot_date,message,source,labels,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(pid, 'Inquiry', clientName, email, property, location, collection, timeline, message, 'inquiry', '', now, now).run();
    } catch (_) { /* don't fail the contact form if DB write fails */ }
  }

  return jsonResponse({ ok: true });
}
