// Cloudflare Worker — Synology Photos sharing CORS proxy
// Deploy at: Workers & Pages → Create Worker → paste → Deploy
// No secrets or credentials required.
//
// How it works:
// 1. Loads the NAS sharing page to get a sharing_sid session cookie
// 2. Forwards all requests (JSON API + thumbnails + downloads) to the NAS
//    with the sharing cookie AND the X-SYNO-SHARING header that Synology
//    requires to activate the sharing session for data API calls

const NAS_SHARE_API  = 'https://nas.coastaltravelcompany.com/mo/sharing/webapi/entry.cgi';
const NAS_SHARE_PAGE = 'https://nas.coastaltravelcompany.com/mo/sharing/';

const CORS = {
  'Access-Control-Allow-Origin':   'https://coastaltravelcompany.com',
  'Access-Control-Allow-Methods':  'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':  'Content-Type',
  'Access-Control-Expose-Headers': 'Content-Disposition',
  'Access-Control-Max-Age':        '86400',
};

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

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

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const bodyText = request.method === 'POST' ? await request.text() : '';

  // Passphrase comes from POST body or GET query string
  let passphrase;
  if (request.method === 'POST') {
    passphrase = extractPassphrase(new URLSearchParams(bodyText).get('passphrase'));
  } else {
    passphrase = extractPassphrase(url.searchParams.get('passphrase'));
  }

  if (!passphrase) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 400, message: 'Missing passphrase' } }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  let nasCookie;
  try {
    nasCookie = await getSharingSid(passphrase);
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 502, message: 'Sharing session failed: ' + err.message } }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  // Forward the request to the NAS sharing API
  const nasUrl = request.method === 'GET'
    ? NAS_SHARE_API + url.search   // thumbnail / download — preserve query string
    : NAS_SHARE_API;               // JSON API calls via POST

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
      body:    request.method === 'POST' ? bodyText : undefined,
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
