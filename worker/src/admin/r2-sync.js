import { jsonResponse, authRequired, forbidden } from '../utils.js';
import { getAuth } from '../jwt.js';
import { getGallery, putGallery } from '../kv.js';
import { getSharingSid } from '../gallery-proxy.js';
import { NAS_SHARE_API } from '../constants.js';

const THUMB_BATCH = 20; // photos processed per sync call

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

  // ── List photos in the shared album ─────────────────────────────────────────
  const listParams = new URLSearchParams({
    api:         'SYNO.Foto.Browse.Item',
    version:     '1',
    method:      'list',
    album_id:    '0',
    offset:      String(offset),
    limit:       String(THUMB_BATCH),
    _sharing_id: gallery.passphrase,
  });
  if (nasAuth.sid) listParams.set('sid', nasAuth.sid);

  let items = [], total = 0;
  try {
    const listRes  = await fetch(NAS_SHARE_API + '?' + listParams, {
      headers: { Cookie: nasAuth.cookie, 'X-SYNO-SHARING': gallery.passphrase },
    });
    const listData = await listRes.json();
    items = listData?.data?.list  || [];
    total = listData?.data?.total ?? items.length;
  } catch (err) {
    return jsonResponse({ error: 'Failed to list NAS photos: ' + err.message }, 502);
  }

  // ── Download each thumbnail and upload to R2 ─────────────────────────────
  let synced = 0, failed = 0;
  for (const item of items) {
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
      const thumbRes = await fetch(NAS_SHARE_API + '?' + thumbParams, {
        headers: { Cookie: nasAuth.cookie, 'X-SYNO-SHARING': gallery.passphrase },
      });
      if (!thumbRes.ok) { failed++; continue; }
      const ct = thumbRes.headers.get('Content-Type') || '';
      if (!ct.startsWith('image/')) { failed++; continue; }

      const bytes  = await thumbRes.arrayBuffer();
      const r2Key  = `galleries/${galleryId}/thumbs/${item.id}.jpg`;
      await env.ASSETS.put(r2Key, bytes, {
        httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=86400' },
      });
      synced++;
    } catch {
      failed++;
    }
  }

  // ── Mark gallery synced in KV once all pages are done ────────────────────
  const done = (offset + items.length) >= total;
  if (done && synced > 0) {
    gallery.r2_synced = true;
    await putGallery(gallery, env.KV);
  }

  return jsonResponse({
    ok:     true,
    synced,
    failed,
    offset,
    total,
    done,
    next_offset: done ? null : offset + items.length,
  });
}
