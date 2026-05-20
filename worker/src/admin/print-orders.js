import { ALLOWED_ORIGIN, CONTACT_TO } from '../constants.js';
import { jsonResponse, escHtml } from '../utils.js';
import { getAuth } from '../jwt.js';

const PRODUCTS = [
  { size: '4x6',   label: '4 × 6"',   materials: { glossy: 1500, matte: 1800 } },
  { size: '5x7',   label: '5 × 7"',   materials: { glossy: 2000, matte: 2400 } },
  { size: '8x10',  label: '8 × 10"',  materials: { glossy: 3500, matte: 4200, canvas: 5500 } },
  { size: '11x14', label: '11 × 14"', materials: { glossy: 5500, matte: 6500, canvas: 8500 } },
  { size: '16x20', label: '16 × 20"', materials: { glossy: 8500, matte: 10000, canvas: 13500 } },
  { size: '20x30', label: '20 × 30"', materials: { glossy: 13000, matte: 15500, canvas: 19500 } },
];
const SHIPPING_CENTS = 895;

function lookupPrice(size, material) {
  const product = PRODUCTS.find(p => p.size === size);
  if (!product) return null;
  const price = product.materials[material];
  return price ?? null;
}

export async function handlePublicPrintProducts() {
  return jsonResponse({ products: PRODUCTS, shipping_cents: SHIPPING_CENTS });
}

export async function handlePublicCreatePrintOrder(request, env) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: 'Online payment not configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { size, material, quantity, customer_name, customer_email, shipping_address,
          photo_filename, photo_index, gallery_passphrase } = body;

  if (!size || !material || !customer_name || !customer_email || !shipping_address) {
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  const unitPrice = lookupPrice(size, material);
  if (unitPrice === null) return jsonResponse({ error: 'Invalid size or material' }, 400);

  const qty = Math.max(1, Math.min(99, Math.round(Number(quantity) || 1)));
  const subtotal = unitPrice * qty;
  const total = subtotal + SHIPPING_CENTS;

  const id         = crypto.randomUUID();
  const magicToken = crypto.randomUUID();
  const now        = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO print_orders
      (id,gallery_passphrase,photo_filename,photo_index,size,material,quantity,
       unit_price_cents,subtotal_cents,shipping_cents,total_cents,
       customer_name,customer_email,shipping_address,magic_token,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_payment',?,?)`
  ).bind(
    id,
    gallery_passphrase || '',
    photo_filename || '',
    Math.round(Number(photo_index) || 0),
    size, material, qty,
    unitPrice, subtotal, SHIPPING_CENTS, total,
    customer_name, customer_email,
    typeof shipping_address === 'string' ? shipping_address : JSON.stringify(shipping_address),
    magicToken, now, now
  ).run();

  const product = PRODUCTS.find(p => p.size === size);
  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', `${ALLOWED_ORIGIN}/print-order.html#${magicToken}`);
  params.append('cancel_url',  `${ALLOWED_ORIGIN}/print-order.html#${magicToken}&cancelled=1`);
  params.append('customer_email', customer_email);
  params.append('metadata[print_order_id]', id);
  params.append('metadata[magic_token]', magicToken);

  const lineLabel = `${product?.label || size} — ${material.charAt(0).toUpperCase() + material.slice(1)} Print`;
  params.append('line_items[0][price_data][currency]', 'usd');
  params.append('line_items[0][price_data][product_data][name]', lineLabel);
  if (photo_filename) {
    params.append('line_items[0][price_data][product_data][description]', `Photo: ${photo_filename}`);
  }
  params.append('line_items[0][price_data][unit_amount]', String(unitPrice));
  params.append('line_items[0][quantity]', String(qty));

  params.append('line_items[1][price_data][currency]', 'usd');
  params.append('line_items[1][price_data][product_data][name]', 'Standard Shipping');
  params.append('line_items[1][price_data][unit_amount]', String(SHIPPING_CENTS));
  params.append('line_items[1][quantity]', '1');

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const session = await res.json();
  if (!res.ok) return jsonResponse({ error: session.error?.message || 'Stripe error' }, 502);

  await env.DB.prepare('UPDATE print_orders SET stripe_session_id=?,updated_at=? WHERE id=?')
    .bind(session.id, now, id).run();

  return jsonResponse({ url: session.url, token: magicToken });
}

export async function handlePublicPrintOrder(request, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(
    `SELECT id,size,material,quantity,unit_price_cents,subtotal_cents,shipping_cents,
            total_cents,customer_name,customer_email,shipping_address,
            photo_filename,status,paid_at,created_at
     FROM print_orders WHERE magic_token=?`
  ).bind(token).all();
  if (!results.length) return jsonResponse({ error: 'Order not found' }, 404);
  return jsonResponse(results[0]);
}

// Called from handleStripeWebhook in invoices.js when metadata.print_order_id is present
export async function handlePrintOrderPaid(env, session) {
  if (!env.DB) return;
  const orderId = session.metadata?.print_order_id;
  if (!orderId) return;
  const { results } = await env.DB.prepare('SELECT * FROM print_orders WHERE id=?').bind(orderId).all();
  if (!results.length || results[0].status === 'paid') return;
  const order = results[0];
  const now = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE print_orders SET status=?,paid_at=?,stripe_payment_intent_id=?,updated_at=? WHERE id=?'
  ).bind('paid', now, session.payment_intent || '', now, orderId).run();

  const product = PRODUCTS.find(p => p.size === order.size);
  const sizeLabel    = product?.label || order.size;
  const materialLabel = order.material.charAt(0).toUpperCase() + order.material.slice(1);
  const totalStr = '$' + (order.total_cents / 100).toFixed(2);

  const addr = (() => { try { return JSON.parse(order.shipping_address); } catch { return {}; } })();
  const addrStr = [addr.line1, addr.line2, addr.city, addr.state, addr.zip].filter(Boolean).join(', ');

  if (env.RESEND_API_KEY && order.customer_email) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>',
        to:   [order.customer_email],
        subject: 'Your print order is confirmed',
        html: `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(order.customer_name)},</p>
<p style="font-family:sans-serif;font-size:15px">Thank you! Your print order has been received and payment confirmed.</p>
<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse;margin:16px 0">
  <tr><td style="padding:4px 16px 4px 0;color:#666">Print</td><td><strong>${escHtml(sizeLabel)} — ${escHtml(materialLabel)}</strong></td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#666">Quantity</td><td>${order.quantity}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#666">Photo</td><td>${escHtml(order.photo_filename || 'Selected photo')}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#666">Ship to</td><td>${escHtml(addrStr)}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#666">Total paid</td><td><strong>${totalStr}</strong></td></tr>
</table>
<p style="font-family:sans-serif;font-size:15px">Your print will be produced and shipped within 5–7 business days. We'll send a shipping confirmation with tracking once it's on its way.</p>
<p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`,
      }),
    }).catch(() => {});
  }

  if (env.RESEND_API_KEY) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>',
        to:   [CONTACT_TO],
        subject: `New print order — ${order.customer_name} — ${sizeLabel} ${materialLabel}`,
        html: `<p style="font-family:sans-serif;font-size:15px">New print order received.</p>
<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse;margin:16px 0">
  <tr><td style="padding:4px 16px 4px 0;color:#666">Customer</td><td>${escHtml(order.customer_name)} &lt;${escHtml(order.customer_email)}&gt;</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#666">Print</td><td>${escHtml(sizeLabel)} — ${escHtml(materialLabel)} × ${order.quantity}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#666">Photo</td><td>${escHtml(order.photo_filename || '(unknown)')}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#666">Ship to</td><td>${escHtml(addrStr)}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#666">Total</td><td>${totalStr}</td></tr>
  <tr><td style="padding:4px 16px 4px 0;color:#666">Order ID</td><td>${orderId}</td></tr>
</table>`,
      }),
    }).catch(() => {});
  }
}

// Admin: list all print orders
export async function handleAdminPrintOrders(request, env) {
  const p = await getAuth(request, env);
  if (!p || p.role !== 'admin') return jsonResponse({ error: 'Forbidden' }, 403);
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(
    `SELECT id,size,material,quantity,total_cents,customer_name,customer_email,
            shipping_address,photo_filename,status,paid_at,created_at
     FROM print_orders ORDER BY created_at DESC LIMIT 200`
  ).all();
  return jsonResponse({ orders: results });
}
