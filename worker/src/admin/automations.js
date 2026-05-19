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
  }
}
