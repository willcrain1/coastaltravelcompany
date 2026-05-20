import { ALLOWED_ORIGIN, NAS_SHARE_API, CORS } from '../constants.js';
import { jsonResponse, authRequired, forbidden, escHtml } from '../utils.js';
import { getAuth } from '../jwt.js';
import { getGallery } from '../kv.js';
import { getSharingSid, applyWatermark } from '../gallery-proxy.js';
import { CONTACT_TO } from '../constants.js';

const LICENSE_LABELS = {
  personal:           'Personal Use',
  commercial_digital: 'Commercial Digital',
  commercial_print:   'Commercial Print',
  exclusive:          'Exclusive Commercial',
};

const LICENSE_DESCRIPTION = {
  personal:           'Social media, personal prints, non-commercial use.',
  commercial_digital: 'Website, digital advertising, email marketing, social media campaigns.',
  commercial_print:   'Brochures, signage, magazines, print advertising.',
  exclusive:          'All commercial rights; photo removed from store after purchase.',
};

// ── Admin: list store photos ─────────────────────────────────────────────────
export async function handleAdminStoreList(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(
    'SELECT * FROM store_photos ORDER BY featured DESC, created_at DESC'
  ).all();
  return jsonResponse(results);
}

// ── Admin: create store listing ──────────────────────────────────────────────
export async function handleAdminStoreCreate(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const body = await request.json();
  const { gallery_id, nas_photo_id, title, description,
          personal_price_cents, commercial_digital_price_cents,
          commercial_print_price_cents, exclusive_price_cents, featured } = body;
  if (!gallery_id || !nas_photo_id)
    return jsonResponse({ error: 'gallery_id and nas_photo_id required' }, 400);
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO store_photos
     (id,gallery_id,nas_photo_id,title,description,
      personal_price_cents,commercial_digital_price_cents,
      commercial_print_price_cents,exclusive_price_cents,
      featured,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, gallery_id, Number(nas_photo_id),
    title || '', description || '',
    Number(personal_price_cents) || 0,
    Number(commercial_digital_price_cents) || 0,
    Number(commercial_print_price_cents) || 0,
    Number(exclusive_price_cents) || 0,
    featured ? 1 : 0, 'active', now, now,
  ).run();
  const { results } = await env.DB.prepare('SELECT * FROM store_photos WHERE id=?').bind(id).all();
  return jsonResponse(results[0], 201);
}

// ── Admin: update store listing ──────────────────────────────────────────────
export async function handleAdminStoreUpdate(request, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare('SELECT * FROM store_photos WHERE id=?').bind(id).all();
  if (!results.length) return jsonResponse({ error: 'Not found' }, 404);
  const existing = results[0];
  const body = await request.json();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE store_photos SET
       title=?,description=?,
       personal_price_cents=?,commercial_digital_price_cents=?,
       commercial_print_price_cents=?,exclusive_price_cents=?,
       featured=?,status=?,updated_at=?
     WHERE id=?`
  ).bind(
    body.title           !== undefined ? body.title           : existing.title,
    body.description     !== undefined ? body.description     : existing.description,
    body.personal_price_cents           !== undefined ? Number(body.personal_price_cents)           : existing.personal_price_cents,
    body.commercial_digital_price_cents !== undefined ? Number(body.commercial_digital_price_cents) : existing.commercial_digital_price_cents,
    body.commercial_print_price_cents   !== undefined ? Number(body.commercial_print_price_cents)   : existing.commercial_print_price_cents,
    body.exclusive_price_cents          !== undefined ? Number(body.exclusive_price_cents)          : existing.exclusive_price_cents,
    body.featured !== undefined ? (body.featured ? 1 : 0) : existing.featured,
    body.status   !== undefined ? body.status : existing.status,
    now, id,
  ).run();
  const { results: updated } = await env.DB.prepare('SELECT * FROM store_photos WHERE id=?').bind(id).all();
  return jsonResponse(updated[0]);
}

// ── Admin: delete store listing ──────────────────────────────────────────────
export async function handleAdminStoreDelete(request, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  await env.DB.prepare('DELETE FROM store_photos WHERE id=?').bind(id).run();
  return jsonResponse({ ok: true });
}

// ── Admin: browse photos in a gallery (proxy to Synology) ───────────────────
export async function handleAdminStoreBrowse(request, env, galleryId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  const gallery = await getGallery(galleryId, env.KV);
  if (!gallery) return jsonResponse({ error: 'Gallery not found' }, 404);
  const passphrase = gallery.passphrase;
  if (!passphrase) return jsonResponse({ error: 'Gallery has no passphrase' }, 400);
  let nasAuth;
  try { nasAuth = await getSharingSid(passphrase, gallery.sharePassword || null); }
  catch (err) { return jsonResponse({ error: 'NAS session failed: ' + err.message }, 502); }
  const params = new URLSearchParams({
    api: 'SYNO.Foto.Browse.Item', version: '1', method: 'list',
    offset: '0', limit: '200', type: 'photo,video',
    _sharing_id: passphrase,
  });
  if (nasAuth.sid) params.set('sid', nasAuth.sid);
  const nasRes = await fetch(NAS_SHARE_API + '?' + params, {
    headers: { 'Cookie': nasAuth.cookie, 'X-SYNO-SHARING': passphrase },
  });
  const data = await nasRes.json();
  return jsonResponse(data);
}

// ── Admin: thumbnail for gallery photo browser ───────────────────────────────
export async function handleAdminStoreBrowseThumb(request, env, galleryId, nasPhotoId) {
  const p = await getAuth(request, env);
  if (!p) return new Response('Unauthorized', { status: 401, headers: CORS });
  if (p.role !== 'admin') return new Response('Forbidden', { status: 403, headers: CORS });
  const gallery = await getGallery(galleryId, env.KV);
  if (!gallery) return new Response('Not found', { status: 404, headers: CORS });
  let nasAuth;
  try { nasAuth = await getSharingSid(gallery.passphrase, gallery.sharePassword || null); }
  catch { return new Response('Unavailable', { status: 502, headers: CORS }); }
  const params = new URLSearchParams({
    api: 'SYNO.Foto.Thumbnail', version: '2', method: 'get',
    id: String(nasPhotoId), type: 'unit', size: 'sm', cache_key: String(nasPhotoId),
    _sharing_id: gallery.passphrase,
  });
  if (nasAuth.sid) params.set('sid', nasAuth.sid);
  const nasRes = await fetch(NAS_SHARE_API + '?' + params, {
    headers: { 'Cookie': nasAuth.cookie, 'X-SYNO-SHARING': gallery.passphrase },
  });
  if (!nasRes.ok) return new Response('Unavailable', { status: 502, headers: CORS });
  const resHeaders = new Headers(CORS);
  resHeaders.set('Content-Type', nasRes.headers.get('Content-Type') || 'image/jpeg');
  resHeaders.set('Cache-Control', 'private, max-age=3600');
  return new Response(nasRes.body, { status: 200, headers: resHeaders });
}

// ── Public: list active store photos ─────────────────────────────────────────
export async function handlePublicStoreList(request, env) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const url = new URL(request.url);
  const featured = url.searchParams.get('featured');
  let query = `SELECT id,title,description,
    personal_price_cents,commercial_digital_price_cents,
    commercial_print_price_cents,exclusive_price_cents,
    featured,status,created_at
    FROM store_photos WHERE status='active'`;
  if (featured === '1') query += ' AND featured=1';
  query += ' ORDER BY featured DESC, created_at DESC';
  const { results } = await env.DB.prepare(query).all();
  return jsonResponse(results);
}

// ── Public: single store photo details ───────────────────────────────────────
export async function handlePublicStorePhoto(request, env, id) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(
    `SELECT id,title,description,
     personal_price_cents,commercial_digital_price_cents,
     commercial_print_price_cents,exclusive_price_cents,
     featured,status,created_at
     FROM store_photos WHERE id=? AND status='active'`
  ).bind(id).all();
  if (!results.length) return jsonResponse({ error: 'Not found' }, 404);
  return jsonResponse({
    ...results[0],
    license_tiers: Object.entries(LICENSE_LABELS).map(([key, label]) => ({
      key, label,
      description: LICENSE_DESCRIPTION[key],
      price_cents: results[0][key + '_price_cents'] ?? 0,
    })),
  });
}

// ── Public: serve watermarked preview image ───────────────────────────────────
export async function handlePublicStorePreview(request, env, id) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(
    'SELECT gallery_id,nas_photo_id FROM store_photos WHERE id=? AND status!=?'
  ).bind(id, 'unlisted').all();
  if (!results.length) return new Response('Not found', { status: 404, headers: CORS });
  const { gallery_id, nas_photo_id } = results[0];
  const gallery = await getGallery(gallery_id, env.KV);
  if (!gallery) return new Response('Gallery not found', { status: 404, headers: CORS });
  let nasAuth;
  try { nasAuth = await getSharingSid(gallery.passphrase, gallery.sharePassword || null); }
  catch { return new Response('Preview unavailable', { status: 502, headers: CORS }); }
  const params = new URLSearchParams({
    api: 'SYNO.Foto.Thumbnail', version: '2', method: 'get',
    id: String(nas_photo_id), type: 'unit', size: 'xl', cache_key: String(nas_photo_id),
    _sharing_id: gallery.passphrase,
  });
  if (nasAuth.sid) params.set('sid', nasAuth.sid);
  const nasRes = await fetch(NAS_SHARE_API + '?' + params, {
    headers: { 'Cookie': nasAuth.cookie, 'X-SYNO-SHARING': gallery.passphrase },
  });
  if (!nasRes.ok) return new Response('Preview unavailable', { status: 502, headers: CORS });
  const ct = nasRes.headers.get('Content-Type') || '';
  if (!ct.startsWith('image/')) return new Response('Preview unavailable', { status: 502, headers: CORS });
  const imageBytes = await nasRes.arrayBuffer();
  try {
    const watermarked = await applyWatermark(imageBytes);
    const resHeaders = new Headers(CORS);
    resHeaders.set('Content-Type', 'image/jpeg');
    resHeaders.set('Cache-Control', 'public, max-age=3600');
    return new Response(watermarked, { status: 200, headers: resHeaders });
  } catch {
    return new Response('Preview unavailable', { status: 502, headers: CORS });
  }
}

// ── Public: initiate Stripe checkout for a cart ───────────────────────────────
export async function handlePublicStoreCheckout(request, env) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: 'Online payment not configured' }, 503);
  const body = await request.json();
  const { items, email, buyer_name } = body;
  if (!Array.isArray(items) || !items.length)
    return jsonResponse({ error: 'items array required' }, 400);
  if (!email) return jsonResponse({ error: 'email required' }, 400);

  // Validate items and build purchase records
  const purchaseRows = [];
  const lineItems    = [];
  for (const item of items) {
    const { store_photo_id, license_type } = item;
    if (!store_photo_id || !license_type) return jsonResponse({ error: 'store_photo_id and license_type required per item' }, 400);
    const col = license_type + '_price_cents';
    const validCols = ['personal_price_cents','commercial_digital_price_cents','commercial_print_price_cents','exclusive_price_cents'];
    if (!validCols.includes(col)) return jsonResponse({ error: 'Invalid license_type' }, 400);
    const { results } = await env.DB.prepare(
      `SELECT id,title,status,${col} as price_cents FROM store_photos WHERE id=?`
    ).bind(store_photo_id).all();
    if (!results.length || results[0].status !== 'active')
      return jsonResponse({ error: `Photo ${store_photo_id} not available` }, 400);
    purchaseRows.push({ store_photo_id, license_type, price_cents: results[0].price_cents, title: results[0].title });
    lineItems.push({
      price_data: { currency: 'usd', product_data: { name: `${results[0].title || 'Photo'} — ${LICENSE_LABELS[license_type]}` }, unit_amount: results[0].price_cents },
      quantity: 1,
    });
  }

  const sessionId = crypto.randomUUID();
  const params    = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('customer_email', email);
  params.append('success_url', `${ALLOWED_ORIGIN}/shop-confirmation.html?session={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', `${ALLOWED_ORIGIN}/shop.html`);
  params.append('metadata[purchase_type]', 'store');
  params.append('metadata[buyer_email]', email);
  params.append('metadata[buyer_name]', buyer_name || '');
  params.append('metadata[purchase_rows]', JSON.stringify(purchaseRows.map(r => ({ ...r, download_token: crypto.randomUUID() }))));
  lineItems.forEach((li, i) => {
    params.append(`line_items[${i}][price_data][currency]`, li.price_data.currency);
    params.append(`line_items[${i}][price_data][product_data][name]`, li.price_data.product_data.name);
    params.append(`line_items[${i}][price_data][unit_amount]`, String(li.price_data.unit_amount));
    params.append(`line_items[${i}][quantity]`, '1');
  });

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const session = await res.json();
  if (!res.ok) return jsonResponse({ error: session.error?.message || 'Stripe error' }, 502);
  return jsonResponse({ url: session.url });
}

// ── Stripe webhook handler for store purchases ───────────────────────────────
export async function handleStorePurchaseWebhook(session, env) {
  if (!env.DB) return;
  const { metadata } = session;
  if (metadata?.purchase_type !== 'store') return;

  const email     = metadata.buyer_email || '';
  const buyerName = metadata.buyer_name  || '';
  let rows;
  try { rows = JSON.parse(metadata.purchase_rows || '[]'); } catch { return; }
  if (!rows.length) return;

  const now          = new Date().toISOString();
  const expiresAt    = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const purchaseIds  = [];
  const downloadLinks = [];

  for (const row of rows) {
    const { store_photo_id, license_type, price_cents, download_token } = row;
    const token = download_token || crypto.randomUUID();
    const id    = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO photo_purchases
       (id,store_photo_id,email,buyer_name,license_type,price_cents,
        stripe_session_id,stripe_payment_intent_id,
        download_token,download_expires_at,purchased_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, store_photo_id, email, buyerName, license_type,
      Number(price_cents) || 0,
      session.id || '', session.payment_intent || '',
      token, expiresAt, now,
    ).run();
    purchaseIds.push(id);

    if (license_type === 'exclusive') {
      await env.DB.prepare(
        'UPDATE store_photos SET status=?,updated_at=? WHERE id=?'
      ).bind('sold-exclusive', now, store_photo_id).run();
    }

    downloadLinks.push({
      license: LICENSE_LABELS[license_type],
      description: LICENSE_DESCRIPTION[license_type],
      url: `${ALLOWED_ORIGIN}/shop-confirmation.html?token=${token}`,
    });
  }

  if (env.RESEND_API_KEY && email) {
    const linksHtml = downloadLinks.map(dl =>
      `<div style="background:#f8f6f1;border-radius:6px;padding:14px 18px;margin:10px 0;">` +
      `<p style="margin:0 0 4px;font-weight:600;font-family:sans-serif;font-size:14px;color:#1C1C1C;">${escHtml(dl.license)}</p>` +
      `<p style="margin:0 0 10px;font-size:12px;color:#666;font-family:sans-serif;">${escHtml(dl.description)}</p>` +
      `<a href="${dl.url}" style="background:#2A5C45;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;font-size:13px;font-family:sans-serif;display:inline-block;">Download Full Resolution →</a>` +
      `</div>`
    ).join('');
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
        to:      [email],
        subject: 'Your photo purchase — Coastal Travel Company',
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1C1C1C;">
<h2 style="color:#2A5C45;margin-bottom:4px;">Coastal Travel Company</h2>
<p style="font-size:13px;color:#888;margin:0 0 24px;">Photo License Purchase</p>
<p style="font-size:15px;">Hi ${escHtml(buyerName || email)},</p>
<p style="font-size:15px;">Thank you for your purchase! Your download links are ready below. Each link is valid for 72 hours — please download your files promptly.</p>
${linksHtml}
<p style="font-size:12px;color:#999;margin-top:24px;">Download links expire 72 hours from purchase. Reply to this email if you need assistance.</p>
<p style="font-size:15px;margin-top:16px;">Warmly,<br>Coastal Travel Company</p>
</div>`,
      }),
    }).catch(() => {});
  }

  if (env.RESEND_API_KEY && purchaseIds.length) {
    const totalCents = rows.reduce((s, r) => s + (Number(r.price_cents) || 0), 0);
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
        to:      [CONTACT_TO],
        subject: `Photo store purchase — ${email} — $${(totalCents / 100).toFixed(2)}`,
        html: `<p style="font-family:sans-serif;font-size:15px;">${escHtml(buyerName || email)} purchased ${rows.length} photo license(s) for $${(totalCents / 100).toFixed(2)}.<br>License types: ${rows.map(r => LICENSE_LABELS[r.license_type]).join(', ')}.</p>`,
      }),
    }).catch(() => {});
  }
}

// ── Public: time-limited download ─────────────────────────────────────────────
export async function handleStoreDownload(request, env, token) {
  if (!env.DB) return new Response('Database not configured', { status: 503 });
  const { results } = await env.DB.prepare(
    `SELECT pp.*, sp.gallery_id, sp.nas_photo_id, sp.title
     FROM photo_purchases pp
     JOIN store_photos sp ON pp.store_photo_id = sp.id
     WHERE pp.download_token=?`
  ).bind(token).all();
  if (!results.length) return new Response('Download link not found', { status: 404, headers: CORS });
  const row = results[0];
  if (row.download_expires_at && new Date(row.download_expires_at) < new Date())
    return new Response('Download link expired', { status: 410, headers: CORS });
  const gallery = await getGallery(row.gallery_id, env.KV);
  if (!gallery) return new Response('Gallery not found', { status: 404, headers: CORS });
  let nasAuth;
  try { nasAuth = await getSharingSid(gallery.passphrase, gallery.sharePassword || null); }
  catch { return new Response('Download unavailable', { status: 502, headers: CORS }); }
  const params = new URLSearchParams({
    api: 'SYNO.Foto.Download', version: '1', method: 'get',
    item_id: `[${row.nas_photo_id}]`,
    _sharing_id: gallery.passphrase,
  });
  if (nasAuth.sid) params.set('sid', nasAuth.sid);
  const nasRes = await fetch(NAS_SHARE_API + '?' + params, {
    headers: { 'Cookie': nasAuth.cookie, 'X-SYNO-SHARING': gallery.passphrase },
  });
  if (!nasRes.ok) return new Response('Download unavailable', { status: 502, headers: CORS });
  const resHeaders = new Headers(CORS);
  const ct = nasRes.headers.get('Content-Type') || 'application/octet-stream';
  resHeaders.set('Content-Type', ct);
  const filename = (row.title || 'coastal-photo').replace(/[^a-zA-Z0-9-]/g, '_');
  resHeaders.set('Content-Disposition', `attachment; filename="${filename}.jpg"`);
  return new Response(nasRes.body, { status: 200, headers: resHeaders });
}

// ── Public: license verification page ────────────────────────────────────────
export async function handleLicenseVerify(request, env, licenseId) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(
    `SELECT pp.id,pp.email,pp.buyer_name,pp.license_type,pp.price_cents,pp.purchased_at,pp.download_expires_at,
            sp.title,sp.description
     FROM photo_purchases pp
     JOIN store_photos sp ON pp.store_photo_id = sp.id
     WHERE pp.id=?`
  ).bind(licenseId).all();
  if (!results.length) return jsonResponse({ found: false, message: 'No valid license found' }, 404);
  const r = results[0];
  const name = r.buyer_name
    ? r.buyer_name.split(' ').map((w, i) => i === r.buyer_name.split(' ').length - 1 ? w[0] + '.' : w).join(' ')
    : r.email.split('@')[0];
  return jsonResponse({
    found: true,
    license_id:    r.id,
    buyer:         name,
    photo_title:   r.title,
    license_type:  r.license_type,
    license_label: LICENSE_LABELS[r.license_type] || r.license_type,
    permitted_uses: LICENSE_DESCRIPTION[r.license_type] || '',
    purchased_at:   r.purchased_at,
  });
}

// ── Admin: list purchases ─────────────────────────────────────────────────────
export async function handleAdminStorePurchases(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(
    `SELECT pp.*,sp.title,sp.gallery_id FROM photo_purchases pp
     JOIN store_photos sp ON pp.store_photo_id=sp.id
     ORDER BY pp.purchased_at DESC LIMIT 100`
  ).all();
  return jsonResponse(results);
}
