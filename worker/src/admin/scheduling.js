import { ALLOWED_ORIGIN } from '../constants.js';
import { jsonResponse, authRequired, forbidden, escHtml } from '../utils.js';
import { getAuth } from '../jwt.js';

export async function handleAdminAvailability(request, method, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (method === 'GET') {
    const [winRes, blkRes] = await Promise.all([
      env.DB.prepare('SELECT * FROM availability_windows ORDER BY day_of_week, start_time').all(),
      env.DB.prepare('SELECT * FROM blocked_dates ORDER BY date').all(),
    ]);
    return jsonResponse({ windows: winRes.results, blocked_dates: blkRes.results });
  }
  if (method === 'PUT') {
    const { windows } = await request.json();
    if (!Array.isArray(windows)) return jsonResponse({ error: 'windows array required' }, 400);
    await env.DB.prepare('DELETE FROM availability_windows').run();
    const now = new Date().toISOString();
    for (const w of windows) {
      await env.DB.prepare(
        'INSERT INTO availability_windows (id,day_of_week,start_time,end_time,active,created_at) VALUES (?,?,?,?,?,?)'
      ).bind(crypto.randomUUID(), Number(w.day_of_week), w.start_time, w.end_time, w.active ? 1 : 0, now).run();
    }
    const { results } = await env.DB.prepare('SELECT * FROM availability_windows ORDER BY day_of_week, start_time').all();
    return jsonResponse(results);
  }
}

export async function handleAdminBlockedDates(request, method, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM blocked_dates ORDER BY date').all();
    return jsonResponse(results);
  }
  if (method === 'POST') {
    const { date, reason } = await request.json();
    if (!date) return jsonResponse({ error: 'date required' }, 400);
    const bid = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO blocked_dates (id,date,reason) VALUES (?,?,?)').bind(bid, date, reason || '').run();
    return jsonResponse({ id: bid, date, reason: reason || '' }, 201);
  }
  if (method === 'DELETE' && id) {
    await env.DB.prepare('DELETE FROM blocked_dates WHERE id=?').bind(id).run();
    return jsonResponse({ ok: true });
  }
}

export async function handleAdminProjectScheduleLinks(request, method, env, projectId) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  if (method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM scheduling_links WHERE project_id=? ORDER BY created_at DESC').bind(projectId).all();
    return jsonResponse(results);
  }
  if (method === 'POST') {
    const { link_type, duration_mins } = await request.json();
    const { results: projRows } = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(projectId).all();
    if (!projRows.length) return jsonResponse({ error: 'Project not found' }, 404);
    const proj  = projRows[0];
    const id    = crypto.randomUUID();
    const token = crypto.randomUUID();
    const now   = new Date().toISOString();
    const type  = link_type || 'discovery-call';
    const dur   = Number(duration_mins) || 30;
    await env.DB.prepare(
      'INSERT INTO scheduling_links (id,project_id,link_type,duration_mins,magic_token,expires_at,booked_at,booked_slot,client_name,client_email,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(id, projectId, type, dur, token, '', '', '', proj.client_name, proj.client_email, '', now).run();
    const url   = `${ALLOWED_ORIGIN}/schedule.html#${token}`;
    const label = type === 'shoot' ? 'shoot date' : 'discovery call';
    if (env.RESEND_API_KEY && proj.client_email) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
          to:      [proj.client_email],
          subject: `Schedule your ${label} — Coastal Travel Company`,
          html:    `<p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(proj.client_name)},</p><p style="font-family:sans-serif;font-size:15px">Please choose a time that works for your ${escHtml(label)}.</p><p><a href="${url}" style="background:#2A5C45;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;font-family:sans-serif">Choose a Time</a></p><p style="font-family:sans-serif;font-size:13px;color:#999">Or copy this link: ${url}</p>`,
        }),
      }).catch(() => {});
    }
    return jsonResponse({ id, project_id: projectId, link_type: type, duration_mins: dur, magic_token: token, public_url: url, booked_at: '', created_at: now }, 201);
  }
}

export async function handlePublicSchedule(request, method, env, token) {
  if (!env.DB) return jsonResponse({ error: 'Database not configured' }, 503);
  const { results: linkRows } = await env.DB.prepare('SELECT * FROM scheduling_links WHERE magic_token=?').bind(token).all();
  if (!linkRows.length) return jsonResponse({ error: 'Scheduling link not found' }, 404);
  const link = linkRows[0];

  if (method === 'GET') {
    const [winRes, blkRes, bookedRes] = await Promise.all([
      env.DB.prepare("SELECT * FROM availability_windows WHERE active=1 ORDER BY day_of_week, start_time").all(),
      env.DB.prepare("SELECT * FROM blocked_dates ORDER BY date").all(),
      env.DB.prepare("SELECT booked_slot FROM scheduling_links WHERE booked_slot != ''").all(),
    ]);
    return jsonResponse({
      link_type: link.link_type, duration_mins: link.duration_mins,
      client_name: link.client_name, booked: !!link.booked_at, booked_slot: link.booked_slot,
      available_slots: link.booked_at ? [] : generateAvailableSlots(winRes.results, blkRes.results, bookedRes.results, link.duration_mins || 30),
    });
  }

  if (method === 'POST') {
    if (link.booked_at) return jsonResponse({ error: 'This time has already been booked' }, 409);
    let body; try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid body' }, 400); }
    const { slot, notes } = body;
    if (!slot) return jsonResponse({ error: 'slot required' }, 400);
    const now      = new Date().toISOString();
    await env.DB.prepare('UPDATE scheduling_links SET booked_at=?,booked_slot=?,notes=? WHERE magic_token=?')
      .bind(now, slot, notes || '', token).run();
    const slotDate = new Date(slot);
    const slotEnd  = new Date(slotDate.getTime() + (link.duration_mins || 30) * 60000);
    const label    = link.link_type === 'shoot' ? 'Shoot Date — Coastal Travel Company' : 'Discovery Call — Coastal Travel Company';
    const ics      = generateICS({
      uid: link.id + '@coastaltravelcompany.com', summary: label,
      description: `${label}\\nClient: ${link.client_name}`,
      dtstart: slotDate, dtend: slotEnd,
      organizerEmail: 'noreply@coastaltravelcompany.com',
      attendeeEmail: link.client_email, attendeeName: link.client_name,
    });
    const formattedSlot = slotDate.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
    const emailHtml = `<p style="font-family:sans-serif;font-size:15px">Your ${link.link_type === 'shoot' ? 'shoot date' : 'discovery call'} is confirmed!</p><p style="font-family:sans-serif;font-size:16px;font-weight:600">${formattedSlot} ET</p>${notes ? `<p style="font-family:sans-serif;font-size:14px;color:#555">Notes: ${escHtml(notes)}</p>` : ''}<p style="font-family:sans-serif;font-size:13px;color:#999">A calendar invite is attached.</p>`;
    const icsB64   = btoa(unescape(encodeURIComponent(ics)));
    if (env.RESEND_API_KEY) {
      const att = [{ filename: 'invite.ics', content: icsB64 }];
      await Promise.all([
        fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>', to: [link.client_email], subject: 'Confirmed: ' + label, html: emailHtml, attachments: att }) }).catch(() => {}),
        fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Coastal Travel Company <noreply@coastaltravelcompany.com>', to: ['thecoastaltravelcompany@gmail.com'], subject: `Confirmed: ${label} — ${link.client_name}`, html: emailHtml, attachments: att }) }).catch(() => {}),
      ]);
    }
    if (link.link_type === 'shoot') {
      await env.DB.prepare('UPDATE projects SET shoot_date=?,updated_at=? WHERE id=?')
        .bind(slot.slice(0, 10), now, link.project_id).run();
    }
    return jsonResponse({ ok: true, booked_slot: slot, booked_at: now });
  }
}

function generateICS({ uid, summary, description, dtstart, dtend, organizerEmail, attendeeEmail, attendeeName }) {
  const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'PRODID:-//Coastal Travel Company//EN', 'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTART:' + fmt(dtstart),
    'DTEND:' + fmt(dtend),
    'SUMMARY:' + summary,
    'DESCRIPTION:' + description,
    'ORGANIZER;CN=Coastal Travel Company:mailto:' + organizerEmail,
    attendeeEmail ? 'ATTENDEE;CN=' + attendeeName + ';RSVP=TRUE:mailto:' + attendeeEmail : '',
    'STATUS:CONFIRMED', 'SEQUENCE:0',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

function generateAvailableSlots(windows, blockedDates, bookedSlots, durationMins = 30, numDays = 28) {
  const now     = new Date();
  const blocked = new Set(blockedDates.map(b => b.date));
  const booked  = new Set(bookedSlots.map(s => s.booked_slot).filter(Boolean));
  const slots   = [];
  for (let d = 1; d <= numDays; d++) {
    const day     = new Date(now);
    day.setDate(day.getDate() + d);
    const dow     = day.getDay();
    const dateStr = day.toISOString().slice(0, 10);
    if (blocked.has(dateStr)) continue;
    for (const w of windows.filter(w => Number(w.day_of_week) === dow && w.active)) {
      const [sh, sm] = w.start_time.split(':').map(Number);
      const [eh, em] = w.end_time.split(':').map(Number);
      let cur = sh * 60 + sm;
      const end = eh * 60 + em;
      while (cur + durationMins <= end) {
        const hh  = String(Math.floor(cur / 60)).padStart(2, '0');
        const mm  = String(cur % 60).padStart(2, '0');
        const iso = dateStr + 'T' + hh + ':' + mm + ':00';
        if (!booked.has(iso)) slots.push(iso);
        cur += durationMins;
      }
    }
  }
  return slots;
}
