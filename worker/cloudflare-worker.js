// Cloudflare Worker — Synology Photos CORS proxy + contact form relay
// Deploy via: ./worker/deploy-worker.sh
//
// Security model:
//  1. Origin header validation — rejects requests not from coastaltravelcompany.com
//  2. Session token exchange — POST /token exchanges passphrase for a short-lived
//     sid stored in KV; thumbnails/downloads use ?sid=... so the passphrase is
//     never logged in Cloudflare's request logs
//  3. Synology API allowlist — only Browse.Item, Thumbnail, Download are forwarded
//  4. KV rate limiting — 300 requests/min per gallery passphrase; 5/hour for contact

const NAS_SHARE_API  = 'https://nas.coastaltravelcompany.com/mo/sharing/webapi/entry.cgi';
const NAS_SHARE_PAGE = 'https://nas.coastaltravelcompany.com/mo/sharing/';
const ALLOWED_ORIGIN = 'https://coastaltravelcompany.com';
const RATE_LIMIT         = 300; // max requests per 60 s per gallery
const CONTACT_RATE_LIMIT = 5;   // max contact form submissions per hour per IP
const CONTACT_TO         = 'thecoastaltravelcompany@gmail.com';

const ALLOWED_APIS = new Set([
  'SYNO.Foto.Browse.Item',
  'SYNO.Foto.Thumbnail',
  'SYNO.Foto.Download',
]);

const CORS = {
  'Access-Control-Allow-Origin':   ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods':  'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':  'Content-Type',
  'Access-Control-Expose-Headers': 'Content-Disposition',
  'Access-Control-Max-Age':        '86400',
};

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Per-isolate session cache (passphrase → sharing_sid cookie) ───────────
const sidCache = {};

function parseCookies(headers) {
  const all = headers.getAll
    ? headers.getAll('set-cookie')
    : [headers.get('set-cookie')].filter(Boolean);
  return all.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

async function getSharingSid(passphrase) {
  const cached = sidCache[passphrase];
  if (cached && cached.exp > Date.now()) return cached.cookie;

  const res = await fetch(NAS_SHARE_PAGE + passphrase, { redirect: 'follow' });
  const cookie = parseCookies(res.headers);
  if (!cookie) throw new Error('NAS sharing page returned no session cookie');

  sidCache[passphrase] = { cookie, exp: Date.now() + 2 * 60 * 60 * 1000 };
  return cookie;
}

function extractPassphrase(raw) {
  if (!raw) return '';
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch {}
  }
  return raw;
}

async function checkRateLimit(passphrase) {
  const key = 'rl:' + passphrase;
  const countStr = await KV.get(key);
  const count = countStr ? parseInt(countStr, 10) : 0;
  if (count >= RATE_LIMIT) return false;
  await KV.put(key, String(count + 1), { expirationTtl: 60 });
  return true;
}

async function handleRequest(request) {
  // Preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Browsers always send Origin for cross-origin requests; non-browser callers don't.
  const origin = request.headers.get('Origin');
  if (origin !== ALLOWED_ORIGIN) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);

  // ── Token exchange: POST /token {passphrase} → {sid} ──────────────────
  if (request.method === 'POST' && url.pathname === '/token') {
    const body = await request.text();
    const passphrase = extractPassphrase(new URLSearchParams(body).get('passphrase'));
    if (!passphrase) {
      return new Response(JSON.stringify({ error: 'Missing passphrase' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
    }
    try {
      await getSharingSid(passphrase);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid passphrase' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...CORS } });
    }
    const sid = crypto.randomUUID();
    await KV.put('tok:' + sid, passphrase, { expirationTtl: 14400 }); // 4 hours
    return new Response(JSON.stringify({ sid }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  // ── Contact form: POST /contact ───────────────────────────────────────
  if (request.method === 'POST' && url.pathname === '/contact') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rlKey = 'contact_rl:' + ip;
    const countStr = await KV.get(rlKey);
    const count = countStr ? parseInt(countStr, 10) : 0;
    if (count >= CONTACT_RATE_LIMIT) {
      return new Response(
        JSON.stringify({ error: 'Too many submissions. Please try again later.' }),
        { status: 429, headers: { 'Content-Type': 'application/json', ...CORS } }
      );
    }
    await KV.put(rlKey, String(count + 1), { expirationTtl: 3600 });

    const body = await request.text();
    const p = new URLSearchParams(body);
    const firstName  = (p.get('first-name') || '').trim();
    const lastName   = (p.get('last-name')  || '').trim();
    const email      = (p.get('email')      || '').trim();
    const property   = (p.get('property')   || '').trim();
    const location   = (p.get('location')   || '').trim();
    const collection = (p.get('collection') || '').trim();
    const timeline   = (p.get('timeline')   || '').trim();
    const message    = (p.get('message')    || '').trim();

    if (!firstName || !email || !message) {
      return new Response(
        JSON.stringify({ error: 'Please fill in all required fields.' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
      );
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
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:     'Coastal Travel Company <noreply@coastaltravelcompany.com>',
        to:       [CONTACT_TO],
        reply_to: email,
        subject:  `Inquiry: ${firstName}${lastName ? ' ' + lastName : ''}${property ? ' — ' + property : ''}`,
        html,
      }),
    });

    if (!resendRes.ok) {
      return new Response(
        JSON.stringify({ error: 'Failed to send. Please try again or email us directly.' }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }
      );
    }

    return new Response(JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  // ── Proxy requests ────────────────────────────────────────────────────
  const bodyText = request.method === 'POST' ? await request.text() : '';

  // Resolve passphrase — sid token (preferred, keeps passphrase out of logs) or direct
  let passphrase;
  let rawSid, rawPassphrase;
  if (request.method === 'POST') {
    const params = new URLSearchParams(bodyText);
    rawSid        = params.get('sid');
    rawPassphrase = params.get('passphrase');
  } else {
    rawSid        = url.searchParams.get('sid');
    rawPassphrase = url.searchParams.get('passphrase');
  }

  if (rawSid) {
    const stored = await KV.get('tok:' + rawSid);
    if (!stored) {
      return new Response(
        JSON.stringify({ success: false, error: { code: 401, message: 'Session expired — reload the gallery' } }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...CORS } }
      );
    }
    passphrase = stored;
  } else if (rawPassphrase) {
    passphrase = extractPassphrase(rawPassphrase);
  }

  if (!passphrase) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 400, message: 'Missing passphrase' } }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  // API method allowlist
  const apiMethod = request.method === 'POST'
    ? new URLSearchParams(bodyText).get('api') || ''
    : url.searchParams.get('api') || '';
  if (!ALLOWED_APIS.has(apiMethod)) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 403, message: 'API method not permitted' } }),
      { status: 403, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  // Rate limit per gallery
  if (!await checkRateLimit(passphrase)) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 429, message: 'Too many requests — try again in a minute' } }),
      { status: 429, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  // Get NAS sharing session cookie
  let nasCookie;
  try {
    nasCookie = await getSharingSid(passphrase);
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 502, message: 'Sharing session failed: ' + err.message } }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  // Build forwarded request — strip sid, inject passphrase for Synology
  let nasUrl, nasBody;
  if (request.method === 'GET') {
    const nasParams = new URLSearchParams(url.search);
    nasParams.delete('sid');
    nasParams.delete('passphrase');
    nasParams.set('_sharing_id', JSON.stringify(passphrase));
    nasUrl = NAS_SHARE_API + '?' + nasParams.toString();
  } else {
    const nasParams = new URLSearchParams(bodyText);
    nasParams.delete('sid');
    nasParams.set('passphrase', JSON.stringify(passphrase));
    nasUrl = NAS_SHARE_API;
    nasBody = nasParams.toString();
  }

  const nasReqHeaders = {
    'Cookie':          nasCookie,
    'X-SYNO-SHARING':  passphrase,
  };
  if (request.method === 'POST') {
    nasReqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  let nasResponse;
  try {
    nasResponse = await fetch(nasUrl, {
      method:  request.method,
      headers: nasReqHeaders,
      body:    request.method === 'POST' ? nasBody : undefined,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 502, message: 'NAS unreachable: ' + err.message } }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  const body = await nasResponse.arrayBuffer();
  const resHeaders = new Headers(CORS);

  const ct = nasResponse.headers.get('Content-Type');
  if (ct) resHeaders.set('Content-Type', ct);

  const cd = nasResponse.headers.get('Content-Disposition');
  if (cd) resHeaders.set('Content-Disposition', cd);

  return new Response(body, { status: nasResponse.status, headers: resHeaders });
}
