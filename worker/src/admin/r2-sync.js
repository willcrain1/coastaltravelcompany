import { jsonResponse, authRequired, forbidden } from '../utils.js';
import { getAuth } from '../jwt.js';
import { getGallery, putGallery } from '../kv.js';
import { getSharingSid, sidCache } from '../gallery-proxy.js';
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

  // Force a fresh NAS session on every sync — the per-isolate sidCache can hold
  // a stale session that the NAS silently accepts but returns empty list results for,
  // causing the sync to complete with 0 items written to R2.
  if (offset === 0) delete sidCache[gallery.passphrase];

  let nasAuth;
  try {
    nasAuth = await getSharingSid(gallery.passphrase, gallery.sharePassword || null);
  } catch (err) {
    return jsonResponse({ error: 'NAS session failed: ' + err.message }, 502);
  }

  const nasHeaders = { Cookie: nasAuth.cookie, 'X-SYNO-SHARING': gallery.passphrase };

  // ── List items in the shared album ───────────────────────────────────────────
  // Use POST + form body to match how the gallery proxy calls the NAS browse API.
  // album_id must NOT be sent — for a sharing session the album is implicit in the
  // passphrase/sid. Sending album_id:0 targets the personal library and returns a
  // permission error, which was previously silently swallowed as "0 items".
  const listBody = new URLSearchParams({
    api:        'SYNO.Foto.Browse.Item',
    version:    '4',
    method:     'list',
    offset:     String(offset),
    limit:      String(BATCH),
    passphrase: gallery.passphrase,
    additional: '["thumbnail"]',
  });
  if (nasAuth.sid) listBody.set('sid', nasAuth.sid);

  let items = [], total = 0;
  try {
    const listRes  = await fetch(NAS_SHARE_API, {
      method:  'POST',
      headers: { ...nasHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    listBody.toString(),
    });
    const listData = await listRes.json();
    if (!listData.success) {
      return jsonResponse({
        error: `NAS browse API error (code ${listData?.error?.code ?? 'unknown'})`,
      }, 502);
    }
    items = listData?.data?.list  || [];
    total = listData?.data?.total ?? items.length;
  } catch (err) {
    return jsonResponse({ error: 'Failed to list NAS items: ' + err.message }, 502);
  }

  if (items.length === 0) {
    // total > 0 means the NAS says there are items but returned none — treat as an error
    // so the UI surfaces it rather than silently reporting "synced 0 items".
    if (total > 0) {
      return jsonResponse({ error: `NAS returned 0 items at offset ${offset} but reported total ${total}` }, 502);
    }
    // Genuinely empty album
    return jsonResponse({ ok: true, synced: 0, failed: 0, videosSynced: 0, videosFailed: 0,
      offset, total, done: true, next_offset: null });
  }

  // ── Sync each item: thumbnail for all, full video for video items ─────────────
  let synced = 0, failed = 0, videosSynced = 0, videosFailed = 0;

  for (const item of items) {
    // ── Thumbnail (xl) → R2 thumbs/ ─────────────────────────────────────────
    // type='unit' identifies the media kind; size='xl' is the thumbnail resolution.
    // Previously used type='xl' which the NAS API does not recognise, returning
    // a JSON error (content-type: application/json) instead of the image.
    const thumb  = item.additional?.thumbnail ?? {};
    const thumbId = thumb.unit_id ?? item.id;
    const thumbParams = new URLSearchParams({
      api:         'SYNO.Foto.Thumbnail',
      version:     '2',
      method:      'get',
      id:          String(thumbId),
      cache_key:   String(thumb.cache_key ?? ''),
      type:        'unit',
      size:        'xl',
      _sharing_id: gallery.passphrase,
    });
    if (nasAuth.sid) thumbParams.set('sid', nasAuth.sid);

    try {
      const thumbRes = await fetch(NAS_SHARE_API + '?' + thumbParams, { headers: nasHeaders });
      if (!thumbRes.ok) {
        console.error(`[r2-sync] thumb fetch HTTP ${thumbRes.status} for item ${item.id}`);
        failed++;
      } else {
        const ct = thumbRes.headers.get('Content-Type') || '';
        if (!ct.startsWith('image/')) {
          const body = await thumbRes.text();
          console.error(`[r2-sync] thumb non-image content-type "${ct}" for item ${item.id}:`, body.slice(0, 300));
          failed++;
        } else {
          const bytes = await thumbRes.arrayBuffer();
          await env.ASSETS.put(`galleries/${galleryId}/thumbs/${thumbId}.jpg`, bytes, {
            httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=86400' },
          });
          synced++;
        }
      }
    } catch (err) {
      console.error(`[r2-sync] thumb exception for item ${item.id}:`, err.message);
      failed++;
    }

    // ── Full video → R2 videos/ (stream directly to avoid buffering) ──────────
    // Match client-gallery.html's isVideo(): some NAS items are tagged type='photo'
    // despite being video files (e.g. motion photos), so also check the filename.
    const isVideo = item.type === 'video' ||
      (item.filename && /\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(item.filename));
    if (isVideo) {
      // SYNO.Foto.Download rejects requests carrying _sharing_id (error 804) — unlike
      // Thumbnail/Browse, it expects auth via sid + X-SYNO-SHARING header only, matching
      // how client-gallery.html's dlUrl() calls it.
      const vidParams = new URLSearchParams({
        api:     'SYNO.Foto.Download',
        version: '1',
        method:  'download',
        unit_id: String(item.id),
      });
      if (nasAuth.sid) vidParams.set('sid', nasAuth.sid);

      try {
        const vidRes = await fetch(NAS_SHARE_API + '?' + vidParams, { headers: nasHeaders });
        const vidCt  = vidRes.headers.get('Content-Type') || '';
        if (!vidRes.ok || !vidCt.startsWith('video/')) {
          const body = await vidRes.text();
          console.error(`[r2-sync] video fetch HTTP ${vidRes.status} content-type "${vidCt}" for item ${item.id}:`, body.slice(0, 300));
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
