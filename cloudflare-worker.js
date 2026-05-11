// Cloudflare Worker — Synology Photos API CORS proxy
// Deploy this at: Workers & Pages → Create Worker → paste → Deploy
// Then add your Worker URL to the Gallery Admin settings.
//
// What it does: forwards Synology Photos API calls from coastaltravelcompany.com
// to the NAS and adds CORS headers that Synology doesn't send natively.
// Only JSON API calls go through here — thumbnails and downloads load
// directly from the NAS (img src / href tags don't need CORS headers).

const NAS_API = 'https://nas.coastaltravelcompany.com/mo/sharing/webapi/entry.cgi';

const CORS = {
  'Access-Control-Allow-Origin': 'https://coastaltravelcompany.com',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // Handle preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Forward all query params to NAS
  const url = new URL(request.url);
  const target = NAS_API + url.search;

  let nasResponse;
  try {
    const init = { method: request.method };
    if (request.method === 'POST') {
      init.body = await request.text();
      init.headers = { 'Content-Type': request.headers.get('Content-Type') || 'application/x-www-form-urlencoded' };
    }
    nasResponse = await fetch(target, init);
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

  return new Response(body, { status: nasResponse.status, headers });
}
