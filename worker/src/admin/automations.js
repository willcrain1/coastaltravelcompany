import { ALLOWED_ORIGIN, CONTACT_TO } from '../constants.js';
import { jsonResponse, authRequired, forbidden, escHtml } from '../utils.js';
import { getAuth } from '../jwt.js';

export async function handleAdminAutomations(request, method, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM automation_settings ORDER BY id').all();
    return jsonResponse(results);
  }
  if (method === 'PUT') {
    const updates = await request.json();
    if (!Array.isArray(updates)) return jsonResponse({ error: 'Array required' }, 400);
    const now = new Date().toISOString();
    for (const u of updates) {
      await env.DB.prepare('UPDATE automation_settings SET enabled=?,delay_hours=?,updated_at=? WHERE id=?')
        .bind(u.enabled ? 1 : 0, Number(u.delay_hours) || 0, now, u.id).run();
    }
    const { results } = await env.DB.prepare('SELECT * FROM automation_settings ORDER BY id').all();
    return jsonResponse(results);
  }
}

export async function handleAdminAutomationLogs(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results } = await env.DB.prepare(`
    SELECT al.*, p.client_name FROM automation_logs al
    LEFT JOIN projects p ON al.project_id = p.id
    ORDER BY al.created_at DESC LIMIT 100
  `).all();
  return jsonResponse(results);
}

export async function sendAutomationEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY || !to) return;
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>', to: [to], subject, html }),
  }).catch(() => {});
}

export async function logAutomation(db, projectId, triggerKey, action, now) {
  await db.prepare('INSERT INTO automation_logs (id,project_id,trigger_key,action,status,created_at) VALUES (?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), projectId, triggerKey, action, 'sent', now).run();
}

export async function handleScheduled(event, env) {
  if (!env.DB || !env.RESEND_API_KEY) return;
  const { results: settings } = await env.DB.prepare("SELECT * FROM automation_settings WHERE enabled=1").all();
  if (!settings.length) return;
  const cfg      = Object.fromEntries(settings.map(s => [s.trigger_key, s]));
  const now      = new Date();
  const nowIso   = now.toISOString();
  const hrsSince = iso => (now - new Date(iso)) / 3600000;

  const { results: projects } = await env.DB.prepare(
    "SELECT * FROM projects WHERE stage NOT IN ('Complete') ORDER BY created_at ASC"
  ).all();

  for (const proj of projects) {
    if (!proj.client_email) continue;

    if (cfg['inquiry_auto_reply'] && proj.stage === 'Inquiry' && proj.source === 'inquiry') {
      const { results: logged } = await env.DB.prepare("SELECT id FROM automation_logs WHERE project_id=? AND trigger_key='inquiry_auto_reply'").bind(proj.id).all();
      if (!logged.length) {
        await sendAutomationEmail(env, proj.client_email,
          'Thank you for reaching out — Coastal Travel Company',
          `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p><p style="font-family:sans-serif;font-size:15px">Thank you for your inquiry! We've received your message and will be in touch within 24 hours. In the meantime, feel free to explore our <a href="${ALLOWED_ORIGIN}/collections.html" style="color:#2A5C45">portfolio</a>.</p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`);
        await logAutomation(env.DB, proj.id, 'inquiry_auto_reply', 'auto-reply sent', nowIso);
      }
    }

    if (cfg['proposal_not_opened_followup'] && proj.stage === 'Proposal Sent') {
      const { results: props } = await env.DB.prepare("SELECT * FROM proposals WHERE project_id=? AND (opened_at IS NULL OR opened_at='') ORDER BY created_at DESC LIMIT 1").bind(proj.id).all();
      if (props.length && hrsSince(props[0].created_at) >= cfg['proposal_not_opened_followup'].delay_hours) {
        const { results: logged } = await env.DB.prepare("SELECT id FROM automation_logs WHERE project_id=? AND trigger_key='proposal_not_opened_followup'").bind(proj.id).all();
        if (!logged.length) {
          await sendAutomationEmail(env, proj.client_email,
            'Just checking in — Coastal Travel Company',
            `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p><p style="font-family:sans-serif;font-size:15px">I wanted to make sure you received the proposal I sent. Happy to answer any questions. <a href="${escHtml(props[0].public_url)}" style="color:#2A5C45">View your proposal →</a></p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`);
          await logAutomation(env.DB, proj.id, 'proposal_not_opened_followup', 'follow-up sent', nowIso);
        }
      }
    }

    if (cfg['proposal_not_approved_reminder'] && proj.stage === 'Proposal Sent') {
      const { results: props } = await env.DB.prepare("SELECT * FROM proposals WHERE project_id=? AND status='sent' ORDER BY created_at DESC LIMIT 1").bind(proj.id).all();
      if (props.length && hrsSince(props[0].created_at) >= cfg['proposal_not_approved_reminder'].delay_hours) {
        const { results: logged } = await env.DB.prepare("SELECT id FROM automation_logs WHERE project_id=? AND trigger_key='proposal_not_approved_reminder'").bind(proj.id).all();
        if (!logged.length) {
          await sendAutomationEmail(env, proj.client_email,
            'Dates are filling up — Coastal Travel Company',
            `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p><p style="font-family:sans-serif;font-size:15px">I wanted to follow up before your preferred window fills. Happy to adjust the proposal to fit your needs. <a href="${escHtml(props[0].public_url)}" style="color:#2A5C45">Review your proposal →</a></p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`);
          await logAutomation(env.DB, proj.id, 'proposal_not_approved_reminder', 'reminder sent', nowIso);
        }
      }
    }

    if (cfg['contract_not_signed_reminder'] && proj.stage === 'Contract Sent') {
      if (hrsSince(proj.updated_at) >= cfg['contract_not_signed_reminder'].delay_hours) {
        const { results: logged } = await env.DB.prepare("SELECT id FROM automation_logs WHERE project_id=? AND trigger_key='contract_not_signed_reminder'").bind(proj.id).all();
        if (!logged.length) {
          await sendAutomationEmail(env, proj.client_email,
            'Your contract is ready to sign — Coastal Travel Company',
            `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p><p style="font-family:sans-serif;font-size:15px">Just a reminder that your contract is awaiting your signature. Please sign at your earliest convenience to secure your shoot date.</p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`);
          await logAutomation(env.DB, proj.id, 'contract_not_signed_reminder', 'reminder sent', nowIso);
        }
      }
    }

    if (cfg['post_delivery_review_request'] && proj.stage === 'Delivered') {
      if (hrsSince(proj.updated_at) >= cfg['post_delivery_review_request'].delay_hours) {
        const { results: logged } = await env.DB.prepare("SELECT id FROM automation_logs WHERE project_id=? AND trigger_key='post_delivery_review_request'").bind(proj.id).all();
        if (!logged.length) {
          await sendAutomationEmail(env, proj.client_email,
            'How did we do? — Coastal Travel Company',
            `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p><p style="font-family:sans-serif;font-size:15px">It was a pleasure working with you on ${escHtml(proj.property || 'your project')}. If you have a moment, we'd love to hear your feedback — reviews mean the world to us.</p><p style="font-family:sans-serif;font-size:15px">Thank you for choosing Coastal Travel Company.<br>Warmly,<br>Coastal Travel Company</p>`);
          await logAutomation(env.DB, proj.id, 'post_delivery_review_request', 'review request sent', nowIso);
        }
      }
    }

    if (cfg['contract_signed_deposit_invoice'] && proj.stage === 'Contract Signed') {
      if (hrsSince(proj.updated_at) >= cfg['contract_signed_deposit_invoice'].delay_hours) {
        const { results: existingInvoices } = await env.DB.prepare("SELECT id FROM invoices WHERE project_id=?").bind(proj.id).all();
        if (!existingInvoices.length) {
          const { results: logged } = await env.DB.prepare("SELECT id FROM automation_logs WHERE project_id=? AND trigger_key='contract_signed_deposit_invoice'").bind(proj.id).all();
          if (!logged.length) {
            const { results: props } = await env.DB.prepare(
              "SELECT * FROM proposals WHERE project_id=? AND status='approved' AND selected_package_id!='' ORDER BY created_at DESC LIMIT 1"
            ).bind(proj.id).all();
            let invoiceCreated = false;
            if (props.length) {
              const { results: pkgs } = await env.DB.prepare("SELECT * FROM service_packages WHERE id=?").bind(props[0].selected_package_id).all();
              if (pkgs.length && pkgs[0].base_price > 0) {
                const depositCents  = Math.round(pkgs[0].base_price * 0.5);
                const invoiceId     = crypto.randomUUID();
                const token         = crypto.randomUUID();
                const { results: cntR } = await env.DB.prepare('SELECT COUNT(*) as n FROM invoices').all();
                const invoiceNumber = 'INV-' + String((Number(cntR[0].n) || 0) + 1).padStart(4, '0');
                const dueDate       = new Date(now.getTime() + 7 * 24 * 3600000).toISOString().split('T')[0];
                const lineItems     = JSON.stringify([{ description: `Deposit — ${pkgs[0].name}`, quantity: 1, unit_price_cents: depositCents }]);
                await env.DB.prepare(
                  'INSERT INTO invoices (id,project_id,invoice_number,status,line_items,subtotal_cents,tax_cents,total_cents,due_date,magic_token,stripe_session_id,stripe_payment_intent_id,client_name,client_email,notes,sent_at,paid_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
                ).bind(invoiceId, proj.id, invoiceNumber, 'sent', lineItems, depositCents, 0, depositCents, dueDate, token, '', '', proj.client_name, proj.client_email, 'Deposit (50%) to confirm your booking.', nowIso, '', nowIso, nowIso).run();
                const publicUrl = `${ALLOWED_ORIGIN}/invoice.html#${token}`;
                await env.DB.prepare(
                  'INSERT INTO project_documents (id,project_id,type,title,url,created_at) VALUES (?,?,?,?,?,?)'
                ).bind(crypto.randomUUID(), proj.id, 'invoice', invoiceNumber, publicUrl, nowIso).run();
                await sendAutomationEmail(env, proj.client_email,
                  `Invoice ${invoiceNumber} — Coastal Travel Company`,
                  `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p><p style="font-family:sans-serif;font-size:15px">Thank you for signing your contract! To confirm your booking, please pay the deposit of <strong>$${(depositCents / 100).toFixed(2)}</strong>.</p><p style="margin-top:16px"><a href="${publicUrl}" style="background:#2A5C45;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;display:inline-block;font-size:14px;font-family:sans-serif;">View &amp; Pay Deposit →</a></p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`
                );
                invoiceCreated = true;
              }
            }
            if (!invoiceCreated) {
              await sendAutomationEmail(env, CONTACT_TO,
                `Action needed: deposit invoice for ${proj.client_name}`,
                `<p style="font-family:sans-serif;font-size:15px">The contract for <strong>${escHtml(proj.client_name)}</strong>${proj.property ? ' (' + escHtml(proj.property) + ')' : ''} has been signed. Please create and send a deposit invoice.</p>`
              );
            }
            await logAutomation(env.DB, proj.id, 'contract_signed_deposit_invoice', invoiceCreated ? 'deposit invoice sent' : 'admin notified', nowIso);
          }
        }
      }
    }
  }

  if (cfg['invoice_due_reminder']) {
    const today     = now.toISOString().split('T')[0];
    const threeDays = new Date(now.getTime() + 3 * 24 * 3600000).toISOString().split('T')[0];
    const { results: dueInvoices } = await env.DB.prepare(
      "SELECT * FROM invoices WHERE status='sent' AND due_date!='' AND due_date>=? AND due_date<=?"
    ).bind(today, threeDays).all();
    for (const inv of dueInvoices) {
      if (!inv.client_email) continue;
      const { results: logged } = await env.DB.prepare(
        "SELECT id FROM automation_logs WHERE project_id=? AND trigger_key='invoice_due_reminder' AND action=?"
      ).bind(inv.project_id, inv.id).all();
      if (!logged.length) {
        const publicUrl = `${ALLOWED_ORIGIN}/invoice.html#${inv.magic_token}`;
        const dueStr    = new Date(inv.due_date + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        await sendAutomationEmail(env, inv.client_email,
          `Payment reminder — Invoice ${inv.invoice_number} due ${dueStr}`,
          `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(inv.client_name)},</p><p style="font-family:sans-serif;font-size:15px">This is a friendly reminder that invoice ${escHtml(inv.invoice_number)} for <strong>$${(inv.total_cents / 100).toFixed(2)}</strong> is due on ${dueStr}.</p><p style="margin-top:16px"><a href="${publicUrl}" style="background:#2A5C45;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;display:inline-block;font-size:14px;font-family:sans-serif;">View &amp; Pay Invoice →</a></p><p style="font-family:sans-serif;font-size:15px">Warmly,<br>Coastal Travel Company</p>`
        );
        await logAutomation(env.DB, inv.project_id, 'invoice_due_reminder', inv.id, nowIso);
      }
    }
  }
}
