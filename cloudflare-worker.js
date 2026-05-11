// Cloudflare Worker — Synology Photos API CORS proxy
// Deploy this at: Workers & Pages → Create Worker → paste → Deploy
// Then add your Worker URL to the Gallery Admin settings.
//
// What it does:
// 1. Forwards Synology Photos API calls from coastaltravelcompany.com to the NAS
// 2. Adds CORS headers that Synology doesn't send natively
// 3. Establishes a NAS sharing session by loading the sharing page first
//    (required because the NAS sets sharing_sid and other session cookies on the
//    page load, not via an API call — the Worker threads these cookies for us)

const NAS_API   = 'https://nas.coastaltravelcompany.com/mo/sharing/webapi/entry.cgi';
const NAS_SHARE = 'https://nas.coastaltravelcompany.com/mo/sharing/';

const CORS = {
  'Access-Control-Allow-Origin':   'https://coastaltravelcompany.com',
  'Access-Control-Allow-Methods':  'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':  'Content-Type, X-NAS-Cookie',
  'Access-Control-Expose-Headers': 'X-NAS-Cookie',
  'Access-Control-Max-Age':        '86400',
};

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

// Extract cookie name=value pairs from one or more Set-Cookie headers
function parseCookies(headers) {
  const all = headers.getAll
    ? headers.getAll('set-cookie')
    : [headers.get('set-cookie')].filter(Boolean);
  return all.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const target = NAS_API + url.search;

  const bodyText = request.method === 'POST' ? await request.text() : '';

  // Use session cookie provided by client, or establish one via the sharing page
  let nasCookie = request.headers.get('X-NAS-Cookie') || '';

  if (!nasCookie) {
    // Extract passphrase from POST body (may be JSON-stringified: "vCsa5XjJH")
    const params = new URLSearchParams(bodyText);
    let passphrase = params.get('passphrase') || '';
    if (passphrase.startsWith('"') && passphrase.endsWith('"')) {
      try { passphrase = JSON.parse(passphrase); } catch {}
    }

    if (passphrase) {
      try {
        // Load the NAS sharing page — this sets sharing_sid and other session cookies
        const pageRes = await fetch(NAS_SHARE + passphrase, { redirect: 'follow' });
        nasCookie = parseCookies(pageRes.headers);
      } catch {}
    }
  }

  // Make the actual API call, forwarding the session cookie to the NAS
  let nasResponse;
  try {
    const nasHeaders = {};
    if (nasCookie) nasHeaders['Cookie'] = nasCookie;
    if (request.method === 'POST') {
      nasHeaders['Content-Type'] = request.headers.get('Content-Type') || 'application/x-www-form-urlencoded';
    }
    nasResponse = await fetch(target, {
      method: request.method,
      headers: nasHeaders,
      body: request.method === 'POST' ? bodyText : undefined,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 502, message: 'NAS unreachable: ' + err.message } }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  const body = await nasResponse.arrayBuffer();
  const headers = new Headers(CORS);
  const ct = nasResponse.headers.get('Content-Type');
  if (ct) headers.set('Content-Type', ct);

  // Merge any new cookies from the API response and return them to the client
  const newCookies = parseCookies(nasResponse.headers);
  const allCookies = [nasCookie, newCookies].filter(Boolean).join('; ');
  if (allCookies) headers.set('X-NAS-Cookie', allCookies);

  return new Response(body, { status: nasResponse.status, headers });
}
