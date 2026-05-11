// Cloudflare Worker — Synology Photos admin-auth CORS proxy
// Deploy at: Workers & Pages → Create Worker → paste → Deploy
//
// Secrets required (Worker Settings → Variables → Secrets):
//   NAS_USER — DSM username of the read-only gallery account
//   NAS_PASS — DSM password of that account
//
// What it does:
// 1. Authenticates with the NAS using admin credentials → gets a real SID
// 2. Resolves the album_id from the share passphrase (cached per isolate)
// 3. Forwards SYNO.Foto.Browse.Item calls with album_id + SID to the NAS
// 4. Returns the SID to the browser (X-NAS-Sid) so thumbnail/download URLs work

const NAS_BASE = 'https://nas.coastaltravelcompany.com';
const NAS_API  = NAS_BASE + '/webapi/entry.cgi';

const CORS = {
  'Access-Control-Allow-Origin':   'https://coastaltravelcompany.com',
  'Access-Control-Allow-Methods':  'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':  'Content-Type',
  'Access-Control-Expose-Headers': 'X-NAS-Sid',
  'Access-Control-Max-Age':        '86400',
};

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

// ── In-isolate cache (lives for the lifetime of this Worker isolate) ──────
let sidCache = null;   // { sid: string, exp: number }
let albumCache = {};   // passphrase → album_id

async function getAdminSid() {
  if (sidCache && sidCache.exp > Date.now()) return sidCache.sid;

  const res = await fetch(NAS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      api: 'SYNO.API.Auth', method: 'login', version: '7',
      account: NAS_USER, passwd: NAS_PASS,
      session: 'client_gallery', format: 'sid',
    }).toString(),
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error('NAS auth failed: code ' + (data.error?.code ?? '?'));
  }
  // Cache for 50 minutes (DSM sessions typically last 6 hours)
  sidCache = { sid: data.data.sid, exp: Date.now() + 50 * 60 * 1000 };
  return sidCache.sid;
}

async function resolveAlbumId(passphrase, sid) {
  if (albumCache[passphrase]) return albumCache[passphrase];

  const res = await fetch(NAS_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': 'id=' + sid,
    },
    body: new URLSearchParams({
      api: 'SYNO.Foto.Sharing.Passphrase', method: 'get_permission',
      version: '1', passphrase,
    }).toString(),
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error('Share lookup failed: code ' + (data.error?.code ?? '?'));
  }

  const perm = data.data?.permission ?? {};
  const albumId = perm.album_id ?? perm.team_folder_id ?? null;
  if (!albumId) {
    throw new Error('Share returned no album_id — raw: ' + JSON.stringify(data.data));
  }
  albumCache[passphrase] = albumId;
  return albumId;
}

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Check secrets are configured
  if (typeof NAS_USER === 'undefined' || typeof NAS_PASS === 'undefined') {
    return new Response(
      JSON.stringify({ success: false, error: { code: 503,
        message: 'Worker secrets not configured — set NAS_USER and NAS_PASS in the Cloudflare dashboard.' } }),
      { status: 503, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  const bodyText = request.method === 'POST' ? await request.text() : '';
  const params = new URLSearchParams(bodyText);

  let sid;
  try {
    sid = await getAdminSid();
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 502, message: err.message } }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  // For Browse.Item/list: resolve album_id from passphrase and replace it in the body
  let nasBody = bodyText;
  if (params.get('api') === 'SYNO.Foto.Browse.Item' && params.get('method') === 'list') {
    let rawPass = params.get('passphrase') || '';
    // passphrase may be JSON-quoted: "vCsa5XjJH"
    if (rawPass.startsWith('"') && rawPass.endsWith('"')) {
      try { rawPass = JSON.parse(rawPass); } catch {}
    }
    if (!rawPass) {
      return new Response(
        JSON.stringify({ success: false, error: { code: 400, message: 'Missing passphrase' } }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
      );
    }

    let albumId;
    try {
      albumId = await resolveAlbumId(rawPass, sid);
    } catch (err) {
      return new Response(
        JSON.stringify({ success: false, error: { code: 502, message: err.message } }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }
      );
    }

    const newParams = new URLSearchParams(bodyText);
    newParams.delete('passphrase');
    newParams.set('album_id', String(albumId));
    nasBody = newParams.toString();
  }

  let nasResponse;
  try {
    nasResponse = await fetch(NAS_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': 'id=' + sid,
      },
      body: nasBody,
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
  // Return the SID so the browser can use it for thumbnail/download URLs
  headers.set('X-NAS-Sid', sid);

  return new Response(body, { status: nasResponse.status, headers });
}
