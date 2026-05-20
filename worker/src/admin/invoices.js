import { ALLOWED_ORIGIN, CONTACT_TO } from '../constants.js';
import { jsonResponse, authRequired, forbidden, escHtml } from '../utils.js';
import { getAuth } from '../jwt.js';
import { handlePrintOrderPaid } from './print-orders.js';

function calcInvoiceTotals(lineItems, taxCents) {
  const subtotal = lineItems.reduce(
    (s, i) => s + Math.round((Number(i.quantity) || 1) * (Number(i.unit_price_cents) || 0)), 0
  );
  const tax = Math.round(Number(taxCents) || 0);
  return { subtotal_cents: subtotal, tax_cents: tax, total_cents: subtotal + tax };
}

export async function handleAdminProjectInvoices(request, method, env, projectId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);

  if (method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM invoices WHERE project_id=? ORDER BY created_at DESC'
    ).bind(projectId).all();
    return jsonResponse(results);
  }

  if (method === 'POST') {
    const body = await request.json();
    const { line_items, due_date, notes, tax_cents } = body;
    if (!Array.isArray(line_items) || !line_items.length)
      return jsonResponse({ error: 'line_items array required' }, 400);
    const { results: projR } = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(projectId).all();
    if (!projR.length) return jsonResponse({ error: 'Project not found' }, 404);
    const proj = projR[0];
    const totals = calcInvoiceTotals(line_items, tax_cents);
    const { results: countR } = await env.DB.prepare('SELECT COUNT(*) as n FROM invoices').all();
    const invoiceNumber = 'INV-' + String((Number(countR[0].n) || 0) + 1).padStart(4, '0');
    const id    = crypto.randomUUID();
    const token = crypto.randomUUID();
    const now   = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO invoices (id,project_id,invoice_number,status,line_items,subtotal_cents,tax_cents,total_cents,due_date,magic_token,stripe_session_id,stripe_payment_intent_id,client_name,client_email,notes,sent_at,paid_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      id, projectId, invoiceNumber, 'draft', JSON.stringify(line_items),
      totals.subtotal_cents, totals.tax_cents, totals.total_cents,
      due_date || '', token, '', '', proj.client_name || '', proj.client_email || '',
      notes || '', '', '', now, now
    ).run();
    return jsonResponse({
      id, project_id: projectId, invoice_number: invoiceNumber, status: 'draft',
      line_items: JSON.stringify(line_items), ...totals, due_date: due_date || '',
      magic_token: token, stripe_session_id: '', stripe_payment_intent_id: '',
      client_name: proj.client_name || '', client_email: proj.client_email || '',
      notes: notes || '', sent_at: '', paid_at: '', created_at: now, updated_at: now,
    }, 201);
  }
}

export async function handleAdminInvoice(request, method, env, invoiceId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare('SELECT * FROM invoices WHERE id=?').bind(invoiceId).all();
  if (!results.length) return jsonResponse({ error: 'Invoice not found' }, 404);
  const inv = results[0];

  if (method === 'GET') return jsonResponse(inv);

  if (method === 'PUT') {
    const body   = await request.json();
    const now    = new Date().toISOString();
    const status   = body.status   !== undefined ? body.status   : inv.status;
    const due_date = body.due_date !== undefined ? body.due_date : inv.due_date;
    const notes    = body.notes    !== undefined ? body.notes    : inv.notes;
    const paid_at  = body.paid_at  !== undefined ? body.paid_at  : inv.paid_at;
    let lineItems  = JSON.parse(inv.line_items || '[]');
    let taxCents   = inv.tax_cents;
    if (Array.isArray(body.line_items)) {
      lineItems = body.line_items;
      taxCents  = body.tax_cents !== undefined ? body.tax_cents : inv.tax_cents;
    }
    const totals = calcInvoiceTotals(lineItems, taxCents);
    await env.DB.prepare(
      'UPDATE invoices SET status=?,due_date=?,notes=?,line_items=?,subtotal_cents=?,tax_cents=?,total_cents=?,paid_at=?,updated_at=? WHERE id=?'
    ).bind(status, due_date, notes, JSON.stringify(lineItems), totals.subtotal_cents, totals.tax_cents, totals.total_cents, paid_at, now, invoiceId).run();
    if (status === 'paid' && inv.status !== 'paid') {
      await env.DB.prepare('UPDATE projects SET stage=?,updated_at=? WHERE id=?')
        .bind('Retainer Paid', now, inv.project_id).run();
    }
    const { results: updated } = await env.DB.prepare('SELECT * FROM invoices WHERE id=?').bind(invoiceId).all();
    return jsonResponse(updated[0]);
  }
}

export async function handleAdminInvoiceSend(request, env, invoiceId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare('SELECT * FROM invoices WHERE id=?').bind(invoiceId).all();
  if (!results.length) return jsonResponse({ error: 'Invoice not found' }, 404);
  const inv = results[0];
  const now = new Date().toISOString();
  const publicUrl = `${ALLOWED_ORIGIN}/invoice.html#${inv.magic_token}`;
  await env.DB.prepare('UPDATE invoices SET status=?,sent_at=?,updated_at=? WHERE id=?')
    .bind('sent', now, now, invoiceId).run();
  await env.DB.prepare(
    'INSERT INTO project_documents (id,project_id,type,title,url,created_at) VALUES (?,?,?,?,?,?)'
  ).bind(crypto.randomUUID(), inv.project_id, 'invoice', inv.invoice_number, publicUrl, now).run();
  const items = JSON.parse(inv.line_items || '[]');
  const rowsHtml = items.map(i =>
    `<tr>` +
    `<td style="padding:8px 0;border-bottom:1px solid #f0ebe3;font-family:sans-serif;font-size:14px;">${escHtml(i.description || '')}</td>` +
    `<td style="padding:8px 0;border-bottom:1px solid #f0ebe3;font-family:sans-serif;font-size:14px;text-align:center;">${Number(i.quantity) || 1}</td>` +
    `<td style="padding:8px 0;border-bottom:1px solid #f0ebe3;font-family:sans-serif;font-size:14px;text-align:right;">$${((Number(i.unit_price_cents) || 0) / 100).toFixed(2)}</td>` +
    `<td style="padding:8px 0;border-bottom:1px solid #f0ebe3;font-family:sans-serif;font-size:14px;text-align:right;">$${(((Number(i.quantity) || 1) * (Number(i.unit_price_cents) || 0)) / 100).toFixed(2)}</td>` +
    `</tr>`
  ).join('');
  const dueStr = inv.due_date
    ? new Date(inv.due_date + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  if (env.RESEND_API_KEY && inv.client_email) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
        to:      [inv.client_email],
        subject: `Invoice ${inv.invoice_number} — Coastal Travel Company`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1C1C1C;">
<h2 style="color:#2A5C45;margin-bottom:4px;">Coastal Travel Company</h2>
<p style="font-size:13px;color:#888;margin:0 0 24px;">Invoice ${escHtml(inv.invoice_number)}${dueStr ? ' · Due ' + dueStr : ''}</p>
<p style="font-size:15px;">Hi ${escHtml(inv.client_name)},</p>
<p style="font-size:15px;">Please find your invoice below. You can view and pay securely online.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<thead><tr style="border-bottom:2px solid #E8DDD0;">
<th style="text-align:left;padding:8px 0;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;">Description</th>
<th style="text-align:center;padding:8px 0;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;">Qty</th>
<th style="text-align:right;padding:8px 0;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;">Rate</th>
<th style="text-align:right;padding:8px 0;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;">Amount</th>
</tr></thead>
<tbody>${rowsHtml}</tbody>
</table>
${inv.tax_cents > 0 ? `<p style="text-align:right;font-size:14px;color:#666;margin:4px 0;">Tax: $${(inv.tax_cents / 100).toFixed(2)}</p>` : ''}
<p style="text-align:right;font-size:17px;font-weight:600;margin:8px 0 16px;">Total: $${(inv.total_cents / 100).toFixed(2)}</p>
${inv.notes ? `<p style="font-size:13px;color:#666;border-top:1px solid #f0ebe3;padding-top:12px;">${escHtml(inv.notes)}</p>` : ''}
<p style="margin-top:24px;"><a href="${publicUrl}" style="background:#2A5C45;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;display:inline-block;font-size:14px;font-family:sans-serif;">View &amp; Pay Invoice →</a></p>
<p style="font-size:12px;color:#999;margin-top:8px;">Or copy: ${publicUrl}</p>
<p style="font-size:15px;margin-top:24px;">Warmly,<br>Coastal Travel Company</p>
</div>`,
      }),
    }).catch(() => {});
  }
  const { results: updated } = await env.DB.prepare('SELECT * FROM invoices WHERE id=?').bind(invoiceId).all();
  return jsonResponse({ ...updated[0], public_url: publicUrl });
}

export async function handlePublicInvoice(request, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(
    'SELECT id,invoice_number,status,line_items,subtotal_cents,tax_cents,total_cents,due_date,client_name,notes,sent_at,paid_at,created_at FROM invoices WHERE magic_token=?'
  ).bind(token).all();
  if (!results.length) return jsonResponse({ error: 'Invoice not found' }, 404);
  return jsonResponse({ ...results[0], stripe_enabled: !!env.STRIPE_SECRET_KEY });
}

export async function handleInvoiceCheckout(request, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: 'Online payment not configured' }, 503);
  const { results } = await env.DB.prepare('SELECT * FROM invoices WHERE magic_token=?').bind(token).all();
  if (!results.length) return jsonResponse({ error: 'Invoice not found' }, 404);
  const inv = results[0];
  if (inv.status === 'paid') return jsonResponse({ error: 'Invoice already paid' }, 400);
  if (inv.status === 'void') return jsonResponse({ error: 'Invoice is void' }, 400);
  const items  = JSON.parse(inv.line_items || '[]');
  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', `${ALLOWED_ORIGIN}/invoice.html#${token}`);
  params.append('cancel_url', `${ALLOWED_ORIGIN}/invoice.html#${token}`);
  if (inv.client_email) params.append('customer_email', inv.client_email);
  params.append('metadata[invoice_id]', inv.id);
  params.append('metadata[magic_token]', token);
  items.forEach((item, i) => {
    params.append(`line_items[${i}][price_data][currency]`, 'usd');
    params.append(`line_items[${i}][price_data][product_data][name]`, item.description || 'Service');
    params.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(Number(item.unit_price_cents) || 0)));
    params.append(`line_items[${i}][quantity]`, String(Math.max(1, Math.round(Number(item.quantity) || 1))));
  });
  if (inv.tax_cents > 0) {
    const i = items.length;
    params.append(`line_items[${i}][price_data][currency]`, 'usd');
    params.append(`line_items[${i}][price_data][product_data][name]`, 'Tax');
    params.append(`line_items[${i}][price_data][unit_amount]`, String(inv.tax_cents));
    params.append(`line_items[${i}][quantity]`, '1');
  }
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const session = await res.json();
  if (!res.ok) return jsonResponse({ error: session.error?.message || 'Stripe error' }, 502);
  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE invoices SET stripe_session_id=?,updated_at=? WHERE id=?')
    .bind(session.id, now, inv.id).run();
  return jsonResponse({ url: session.url });
}

export async function handleStripeWebhook(request, env) {
  if (!env.DB || !env.STRIPE_WEBHOOK_SECRET) return jsonResponse({ ok: true });
  const rawBody = await request.text();
  const sig     = request.headers.get('Stripe-Signature') || '';
  const valid   = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return jsonResponse({ error: 'Invalid signature' }, 400);
  let event;
  try { event = JSON.parse(rawBody); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  if (event.type === 'checkout.session.completed') {
    const session   = event.data.object;

    if (session.metadata?.print_order_id && session.payment_status === 'paid') {
      await handlePrintOrderPaid(env, session);
    }

    const invoiceId = session.metadata?.invoice_id;
    if (invoiceId && session.payment_status === 'paid') {
      const now = new Date().toISOString();
      const { results } = await env.DB.prepare('SELECT * FROM invoices WHERE id=?').bind(invoiceId).all();
      if (results.length && results[0].status !== 'paid') {
        const inv = results[0];
        await env.DB.prepare(
          'UPDATE invoices SET status=?,paid_at=?,stripe_payment_intent_id=?,updated_at=? WHERE id=?'
        ).bind('paid', now, session.payment_intent || '', now, invoiceId).run();
        await env.DB.prepare('UPDATE projects SET stage=?,updated_at=? WHERE id=?')
          .bind('Retainer Paid', now, inv.project_id).run();
        const publicUrl = `${ALLOWED_ORIGIN}/invoice.html#${inv.magic_token}`;
        if (env.RESEND_API_KEY && inv.client_email) {
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>',
              to:   [inv.client_email],
              subject: `Payment received — ${inv.invoice_number}`,
              html: `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(inv.client_name)},</p><p style="font-family:sans-serif;font-size:15px">Thank you! We received your payment of <strong>$${(inv.total_cents / 100).toFixed(2)}</strong> for invoice ${escHtml(inv.invoice_number)}.</p><p><a href="${publicUrl}" style="color:#2A5C45;">View receipt →</a></p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`,
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
              subject: `Payment received — ${inv.invoice_number} — ${inv.client_name}`,
              html: `<p style="font-family:sans-serif;font-size:15px">Payment of <strong>$${(inv.total_cents / 100).toFixed(2)}</strong> received from ${escHtml(inv.client_name)} for invoice ${escHtml(inv.invoice_number)}.</p>`,
            }),
          }).catch(() => {});
        }
      }
    }
  }
  return jsonResponse({ ok: true });
}

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = sigHeader.split(',');
  const t  = (parts.find(s => s.startsWith('t='))  || '').slice(2);
  const v1 = (parts.find(s => s.startsWith('v1=')) || '').slice(3);
  if (!t || !v1) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig      = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + rawBody));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === v1;
}

export async function handlePortalInvoices(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(
    `SELECT i.id,i.invoice_number,i.status,i.total_cents,i.due_date,i.paid_at,i.magic_token,i.created_at,
            p.property,p.collection
     FROM invoices i
     JOIN projects p ON i.project_id = p.id
     WHERE i.client_email = ? AND i.status != 'draft'
     ORDER BY i.created_at DESC`
  ).bind(p.sub).all();
  return jsonResponse(results.map(r => ({
    ...r, public_url: `${ALLOWED_ORIGIN}/invoice.html#${r.magic_token}`,
  })));
}
