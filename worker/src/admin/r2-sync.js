import { jsonResponse, authRequired, forbidden } from '../utils.js';
import { getAuth } from '../jwt.js';
import { getGallery, putGallery } from '../kv.js';
import { getSharingSid } from '../gallery-proxy.js';
import { NAS_SHARE_API } from '../constants.js';

const BATCH = 20; // items processed per sync call

export async function handleAdminGallerySyncR2(request, env, galleryId) {
  const payload = await getAuth(request, env);
  if (!payload) return authRequired();
  if (payload.role !== 'admin') return forbidden();

  if (!env.ASSETS) return jsonResponse({ error: 'R2 bucket (ASSETS) not bound — add [[r2_buckets]] to wrangler.toml' }, 503);

  const gallery = await getGallery(galleryId, env.KV);
  if (!gallery) return jsonResponse({ error: 'Gallery not found' }, 404);

  const url    = new URL(request.url);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  let nasAuth;
  try {
    nasAuth = await getSharingSid(gallery.passphrase, gallery.sharePassword || null);
  } catch (err) {
    return jsonResponse({ error: 'NAS session failed: ' + err.message }, 502);
  }

  const nasHeaders = { Cookie: nasAuth.cookie, 'X-SYNO-SHARING': gallery.passphrase };

  // ── List items in the shared album ───────────────────────────────────────────
  const listParams = new URLSearchParams({
    api:         'SYNO.Foto.Browse.Item',
    version:     '1',
    method:      'list',
    album_id:    '0',
    offset:      String(offset),
    limit:       String(BATCH),
    _sharing_id: gallery.passphrase,
  });
  if (nasAuth.sid) listParams.set('sid', nasAuth.sid);

  let items = [], total = 0;
  try {
    const listRes  = await fetch(NAS_SHARE_API + '?' + listParams, { headers: nasHeaders });
    const listData = await listRes.json();
    items = listData?.data?.list  || [];
    total = listData?.data?.total ?? items.length;
  } catch (err) {
    return jsonResponse({ error: 'Failed to list NAS items: ' + err.message }, 502);
  }

  // ── Sync each item: thumbnail for all, full video for video items ─────────────
  let synced = 0, failed = 0, videosSynced = 0, videosFailed = 0;

  for (const item of items) {
    // ── Thumbnail (xl) → R2 thumbs/ ─────────────────────────────────────────
    const thumbParams = new URLSearchParams({
      api:         'SYNO.Foto.Thumbnail',
      version:     '2',
      method:      'get',
      id:          String(item.id),
      type:        'xl',
      _sharing_id: gallery.passphrase,
    });
    if (nasAuth.sid) thumbParams.set('sid', nasAuth.sid);

    try {
      const thumbRes = await fetch(NAS_SHARE_API + '?' + thumbParams, { headers: nasHeaders });
      if (!thumbRes.ok) { failed++; }
      else {
        const ct = thumbRes.headers.get('Content-Type') || '';
        if (!ct.startsWith('image/')) { failed++; }
        else {
          const bytes = await thumbRes.arrayBuffer();
          await env.ASSETS.put(`galleries/${galleryId}/thumbs/${item.id}.jpg`, bytes, {
            httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=86400' },
          });
          synced++;
        }
      }
    } catch {
      failed++;
    }

    // ── Full video → R2 videos/ (stream directly to avoid buffering) ──────────
    if (item.type === 'video') {
      const vidParams = new URLSearchParams({
        api:         'SYNO.Foto.Download',
        version:     '1',
        method:      'download',
        unit_id:     String(item.id),
        _sharing_id: gallery.passphrase,
      });
      if (nasAuth.sid) vidParams.set('sid', nasAuth.sid);

      try {
        const vidRes = await fetch(NAS_SHARE_API + '?' + vidParams, { headers: nasHeaders });
        const vidCt  = vidRes.headers.get('Content-Type') || '';
        if (!vidRes.ok || !vidCt.startsWith('video/')) {
          videosFailed++;
        } else {
          // Stream body directly to R2 — avoids loading the full file into Worker memory
          await env.ASSETS.put(`galleries/${galleryId}/videos/${item.id}`, vidRes.body, {
            httpMetadata: { contentType: vidCt, cacheControl: 'public, max-age=86400' },
          });
          videosSynced++;
        }
      } catch {
        videosFailed++;
      }
    }
  }

  // ── Mark gallery synced in KV once all pages are done ────────────────────────
  const done = (offset + items.length) >= total;
  if (done && (synced > 0 || videosSynced > 0)) {
    gallery.r2_synced = true;
    await putGallery(gallery, env.KV);
  }

  return jsonResponse({
    ok: true,
    synced,
    failed,
    videosSynced,
    videosFailed,
    offset,
    total,
    done,
    next_offset: done ? null : offset + items.length,
  });
}
