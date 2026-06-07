import { jsonResponse, authRequired, forbidden } from './utils.js';
import { getAuth } from './jwt.js';

// Items 32 & 46 — privacy-friendly first-party clickstream/engagement tracking.
// No IP addresses, user agents, or device fingerprints are ever stored — only
// an ephemeral per-tab session_id (crypto.randomUUID, kept in sessionStorage)
// generated client-side, which ties events together for one visit only.

const EVENT_TYPES = new Set(['pageview', 'conversion', 'scroll_depth', 'section_dwell', 'click']);
const EVENTS_PER_MINUTE = 60;

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Truncate referrer down to origin + pathname — never forward query strings or
// fragments, which can carry PII (e.g. password-reset tokens, email addresses).
function sanitizeReferrer(ref) {
  if (!ref || typeof ref !== 'string') return null;
  try {
    const u = new URL(ref);
    return (u.origin + u.pathname).slice(0, 300);
  } catch { return null; }
}

function clean(s, max) {
  if (s == null) return null;
  const v = String(s).trim().slice(0, max);
  return v || null;
}

// ── Public ingest endpoint ───────────────────────────────────────────────────
// POST /analytics/event — body: { session_id, event_type, page, label?, value?,
//   referrer?, utm_source?, utm_medium?, utm_campaign? }
export async function handleAnalyticsEvent(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const session_id = clean(body.session_id, 64);
  const event_type = clean(body.event_type, 32);
  const page       = clean(body.page, 200);

  if (!session_id || !EVENT_TYPES.has(event_type) || !page) {
    return jsonResponse({ error: 'Invalid event' }, 400);
  }

  // Rate limit per session — 60 events/minute, mirroring item 38's
  // POST /re/properties/:id/events design (KV-backed sliding bucket).
  const rlKey    = 'analytics_rl:' + session_id;
  const countStr = await env.KV.get(rlKey);
  const count    = countStr ? parseInt(countStr, 10) : 0;
  if (count >= EVENTS_PER_MINUTE) {
    return jsonResponse({ error: 'Rate limited' }, 429);
  }
  await env.KV.put(rlKey, String(count + 1), { expirationTtl: 60 });

  const id = newId();
  await env.DB.prepare(
    `INSERT INTO analytics_events
       (id, session_id, event_type, page, label, value, referrer, utm_source, utm_medium, utm_campaign)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    session_id,
    event_type,
    page,
    clean(body.label, 200),
    Number.isFinite(body.value) ? Math.trunc(body.value) : null,
    sanitizeReferrer(body.referrer),
    clean(body.utm_source, 100),
    clean(body.utm_medium, 100),
    clean(body.utm_campaign, 150)
  ).run();

  return jsonResponse({ ok: true }, 201);
}

// ── Admin aggregate dashboard ────────────────────────────────────────────────
// GET /admin/analytics/summary?days=30
// Returns aggregated, anonymous rollups only — never raw per-session rows.
export async function handleAdminAnalyticsSummary(request, env) {
  const auth = await getAuth(request, env);
  if (!auth) return authRequired();
  if (auth.role !== 'admin') return forbidden();

  const url  = new URL(request.url);
  let days   = parseInt(url.searchParams.get('days') || '30', 10);
  if (!Number.isFinite(days) || days <= 0 || days > 365) days = 30;
  const since = `-${days} days`;

  const [pageviews, topPages, conversions, scrollDepth, sectionDwell, sources] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT session_id) AS sessions
         FROM analytics_events
        WHERE event_type = 'pageview' AND created_at >= datetime('now', ?)`
    ).bind(since).first(),

    env.DB.prepare(
      `SELECT page, COUNT(*) AS views, COUNT(DISTINCT session_id) AS sessions
         FROM analytics_events
        WHERE event_type = 'pageview' AND created_at >= datetime('now', ?)
        GROUP BY page ORDER BY views DESC LIMIT 20`
    ).bind(since).all(),

    env.DB.prepare(
      `SELECT label, COUNT(*) AS count
         FROM analytics_events
        WHERE event_type = 'conversion' AND created_at >= datetime('now', ?)
        GROUP BY label ORDER BY count DESC LIMIT 20`
    ).bind(since).all(),

    env.DB.prepare(
      `SELECT page, value AS depth_pct, COUNT(*) AS count
         FROM analytics_events
        WHERE event_type = 'scroll_depth' AND created_at >= datetime('now', ?)
        GROUP BY page, value ORDER BY page, depth_pct`
    ).bind(since).all(),

    env.DB.prepare(
      `SELECT page, label AS section_id, COUNT(*) AS samples,
              ROUND(AVG(value)) AS avg_dwell_ms
         FROM analytics_events
        WHERE event_type = 'section_dwell' AND created_at >= datetime('now', ?)
        GROUP BY page, label ORDER BY avg_dwell_ms DESC LIMIT 30`
    ).bind(since).all(),

    env.DB.prepare(
      `SELECT COALESCE(utm_source, '(direct/organic)') AS source,
              COALESCE(utm_medium, '') AS medium,
              COALESCE(utm_campaign, '') AS campaign,
              COUNT(*) AS count, COUNT(DISTINCT session_id) AS sessions
         FROM analytics_events
        WHERE event_type = 'pageview' AND created_at >= datetime('now', ?)
        GROUP BY source, medium, campaign ORDER BY count DESC LIMIT 20`
    ).bind(since).all(),
  ]);

  return jsonResponse({
    days,
    pageviews: { total: pageviews?.total || 0, sessions: pageviews?.sessions || 0 },
    topPages: topPages.results || [],
    conversions: conversions.results || [],
    scrollDepth: scrollDepth.results || [],
    sectionDwell: sectionDwell.results || [],
    sources: sources.results || [],
  });
}
