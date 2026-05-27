import { PhotonImage, draw_text_with_border } from '@cf-wasm/photon';
import { NAS_SHARE_API, NAS_SHARE_PAGE, ALLOWED_APIS, CORS, RATE_LIMIT } from './constants.js';
import { jsonResponse, rateLimitedResponse, authRequired, forbidden } from './utils.js';
import { getAuth } from './jwt.js';
import { getGallery } from './kv.js';
import { checkGalleryUnlockBruteForce, recordGalleryUnlockFailure, clearGalleryUnlockCounter } from './brute-force.js';

// Per-isolate NAS session cache: passphrase → { cookie, sid, exp }
export const sidCache = {};

function parseCookies(headers) {
  const setCookie = headers.get('set-cookie');
  if (!setCookie) return '';
  return setCookie.split(/,(?=\s*[^,;]+=[^,;]+)/)
    .map(c => c.split(';')[0].trim()).join('; ');
}

export async function getSharingSid(passphrase, sharePassword = null) {
  const cached = sidCache[passphrase];
  if (cached && cached.exp > Date.now()) return cached;

  let cookieString, sid;

  if (sharePassword) {
    const params = new URLSearchParams({
      api: 'SYNO.Core.Sharing.Login', version: '1', method: 'login',
      sharing_id: passphrase,
      password: sharePassword,
    });
    const loginRes = await fetch(NAS_SHARE_API + '?' + params, { redirect: 'manual' });
    cookieString = parseCookies(loginRes.headers);
    const setCookieHeader = loginRes.headers.get('set-cookie') || '';
    const sidMatch = setCookieHeader.match(/sharing_sid=([^;]+)/);
    sid = sidMatch ? sidMatch[1] : null;
    if (!cookieString) {
      let loginJson = null;
      try { loginJson = await loginRes.json(); } catch {}
      if (loginJson?.success && loginJson?.data?.sid) {
        sid = loginJson.data.sid;
        cookieString = `sharing_sid=${sid}`;
      } else {
        const detail = loginJson
          ? JSON.stringify(loginJson.error ?? loginJson)
          : `HTTP ${loginRes.status}`;
        throw new Error(`Share login returned no session (${detail})`);
      }
    }
  } else {
    const res = await fetch(NAS_SHARE_PAGE + passphrase, { redirect: 'follow' });
    const setCookieHeader = res.headers.get('set-cookie') || '';
    const sidMatch = setCookieHeader.match(/sharing_sid=([^;]+)/);
    sid = sidMatch ? sidMatch[1] : null;
    cookieString = parseCookies(res.headers);
    if (!cookieString) throw new Error('NAS sharing page returned no session cookie');
  }

  const data = { cookie: cookieString, sid, exp: Date.now() + 2 * 60 * 60 * 1000 };
  sidCache[passphrase] = data;
  return data;
}

export function extractPassphrase(raw) {
  if (!raw) return '';
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch {}
  }
  return raw;
}

export async function checkRateLimit(passphrase, kv) {
  const key      = 'rl:' + passphrase;
  const countStr = await kv.get(key);
  const count    = countStr ? parseInt(countStr, 10) : 0;
  if (count >= RATE_LIMIT) return false;
  await kv.put(key, String(count + 1), { expirationTtl: 60 });
  return true;
}

export async function applyWatermark(imageBytes) {
  const WM_TEXT  = '© Coastal Travel Company';
  const photon   = PhotonImage.new_from_byteslice(new Uint8Array(imageBytes));
  const w        = photon.get_width();
  const h        = photon.get_height();
  const fontSize = 40.0;
  const colW     = 520;
  const rowH     = 110;
  for (let row = 0; row * rowH < h + rowH; row++) {
    const y    = row * rowH;
    const xOff = (row % 2) * Math.round(colW / 2);
    for (let col = -1; col * colW + xOff < w + colW; col++) {
      const x = col * colW + xOff;
      if (x >= 0) draw_text_with_border(photon, WM_TEXT, x, y, fontSize);
    }
  }
  const result = photon.get_bytes_jpeg(85);
  photon.free();
  return result;
}

export async function handleTokenExchange(request, env) {
  const payload = await getAuth(request, env);
  if (!payload) return authRequired();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (await checkGalleryUnlockBruteForce(ip, env.KV)) {
    return rateLimitedResponse('Too many failed gallery access attempts from your network. Please try again in 10 minutes.', 600);
  }

  const body      = await request.text();
  const galleryId = new URLSearchParams(body).get('galleryId');
  if (!galleryId) return jsonResponse({ error: 'Missing galleryId' }, 400);
  const gallery = await getGallery(galleryId, env.KV);
  if (!gallery) return jsonResponse({ error: 'Gallery not found' }, 404);
  if (payload.role !== 'admin') {
    const assigned = gallery.assignedUsers || [];
    if (!assigned.includes(payload.sub)) return forbidden();
  }
  const passphrase = gallery.passphrase;
  if (!passphrase) return jsonResponse({ error: 'Gallery configuration error' }, 500);
  try {
    await getSharingSid(passphrase, gallery.sharePassword || null);
  } catch (err) {
    await recordGalleryUnlockFailure(ip, env.KV);
    return jsonResponse({ error: 'Gallery session failed: ' + err.message }, 401);
  }
  await clearGalleryUnlockCounter(ip, env.KV);
  const sid = crypto.randomUUID();
  await env.KV.put('tok:' + sid, JSON.stringify({ passphrase, sharePassword: gallery.sharePassword || null }), { expirationTtl: 14400 });
  return jsonResponse({ sid });
}

export async function handleNasProxy(request, env) {
  const url      = new URL(request.url);
  const method   = request.method;
  const bodyText = method === 'POST' ? await request.text() : '';

  let passphrase;
  let rawSid, rawPassphrase;
  if (method === 'POST') {
    const params  = new URLSearchParams(bodyText);
    rawSid        = params.get('sid');
    rawPassphrase = params.get('passphrase');
  } else {
    rawSid        = url.searchParams.get('sid');
    rawPassphrase = url.searchParams.get('passphrase');
  }

  let sharePassword = null;
  if (rawSid) {
    const stored = await env.KV.get('tok:' + rawSid);
    if (!stored) {
      return jsonResponse({ success: false, error: { code: 401, message: 'Session expired — reload the gallery' } }, 401);
    }
    try {
      const parsed  = JSON.parse(stored);
      passphrase    = parsed.passphrase;
      sharePassword = parsed.sharePassword || null;
    } catch {
      passphrase = stored;
    }
  } else if (rawPassphrase) {
    passphrase = extractPassphrase(rawPassphrase);
  }

  if (!passphrase) {
    return jsonResponse({ success: false, error: { code: 400, message: 'Missing passphrase' } }, 400);
  }

  const apiMethod = method === 'POST'
    ? new URLSearchParams(bodyText).get('api') || ''
    : url.searchParams.get('api') || '';
  if (!ALLOWED_APIS.has(apiMethod)) {
    return jsonResponse({ success: false, error: { code: 403, message: 'API method not permitted' } }, 403);
  }

  if (!await checkRateLimit(passphrase, env.KV)) {
    return jsonResponse({ success: false, error: { code: 429, message: 'Too many requests — try again in a minute' } }, 429);
  }

  let nasAuth;
  try {
    nasAuth = await getSharingSid(passphrase, sharePassword);
  } catch (err) {
    return jsonResponse({ success: false, error: { code: 502, message: 'Sharing session failed: ' + err.message } }, 502);
  }

  const wantsWatermark = method === 'GET' && url.searchParams.get('watermark') === '1';

  let nasUrl, nasBody;
  if (method === 'GET') {
    const nasParams = new URLSearchParams(url.search);
    nasParams.delete('sid');
    nasParams.delete('passphrase');
    nasParams.delete('watermark');
    nasParams.set('_sharing_id', passphrase);
    if (nasAuth.sid) nasParams.set('sid', nasAuth.sid);
    nasUrl = NAS_SHARE_API + '?' + nasParams.toString();
  } else {
    const nasParams = new URLSearchParams(bodyText);
    nasParams.delete('sid');
    nasParams.set('passphrase', passphrase);
    if (nasAuth.sid) nasParams.set('sid', nasAuth.sid);
    nasUrl  = NAS_SHARE_API;
    nasBody = nasParams.toString();
  }

  const nasReqHeaders = {
    'Cookie':         nasAuth.cookie,
    'X-SYNO-SHARING': passphrase,
  };
  if (method === 'POST') nasReqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) nasReqHeaders['Range'] = rangeHeader;

  let nasResponse;
  try {
    nasResponse = await fetch(nasUrl, {
      method, headers: nasReqHeaders,
      body: method === 'POST' ? nasBody : undefined,
    });
  } catch (err) {
    return jsonResponse({ success: false, error: { code: 502, message: 'NAS unreachable: ' + err.message } }, 502);
  }

  const ct = nasResponse.headers.get('Content-Type') || '';
  const cd = nasResponse.headers.get('Content-Disposition');

  // Stream video responses directly — buffering large video files would exceed Worker memory limits
  if (ct.startsWith('video/')) {
    const resHeaders = new Headers(CORS);
    resHeaders.set('Content-Type', ct);
    if (cd) resHeaders.set('Content-Disposition', cd);
    const acceptRanges = nasResponse.headers.get('Accept-Ranges');
    const contentRange = nasResponse.headers.get('Content-Range');
    const contentLen   = nasResponse.headers.get('Content-Length');
    if (acceptRanges) resHeaders.set('Accept-Ranges', acceptRanges);
    if (contentRange) resHeaders.set('Content-Range', contentRange);
    if (contentLen)   resHeaders.set('Content-Length', contentLen);
    return new Response(nasResponse.body, { status: nasResponse.status, headers: resHeaders });
  }

  const body = await nasResponse.arrayBuffer();

  if (wantsWatermark && ct.startsWith('image/')) {
    try {
      const watermarked = await applyWatermark(body);
      const resHeaders  = new Headers(CORS);
      resHeaders.set('Content-Type', 'image/jpeg');
      resHeaders.set('Content-Disposition', 'attachment; filename="coastal.jpg"');
      return new Response(watermarked, { status: 200, headers: resHeaders });
    } catch (e) {
      console.error('[watermark] applyWatermark failed:', e?.message ?? e);
    }
  }

  const resHeaders = new Headers(CORS);
  if (ct) resHeaders.set('Content-Type', ct);
  if (cd) resHeaders.set('Content-Disposition', cd);
  return new Response(body, { status: nasResponse.status, headers: resHeaders });
}
