import { jsonResponse, authRequired, forbidden } from '../utils.js';
import { getAuth } from '../jwt.js';

const GITHUB_REPO = 'willcrain1/coastaltravelcompany';
const GITHUB_API  = 'https://api.github.com';

// ── Page + zone registry ──────────────────────────────────────────────────────
// Each zone maps one data-content-id in the HTML to a labeled editor field.
// 'text' zones are single-line; 'multiline' zones render a textarea.

const PAGES = {
  'index.html': {
    label: 'Home',
    zones: [
      { id: 'hero-eyebrow',   label: 'Hero eyebrow text',       type: 'text' },
      { id: 'hero-script',    label: 'Brand script accent',      type: 'text' },
      { id: 'hero-title',     label: 'Hero main title',          type: 'text' },
      { id: 'hero-tagline',   label: 'Hero tagline',             type: 'text' },
      { id: 'intro-body',     label: 'Intro paragraph',          type: 'multiline' },
      { id: 'pullquote',      label: 'Pull quote',               type: 'multiline' },
      { id: 'pullquote-cite', label: 'Pull quote attribution',   type: 'text' },
      { id: 'cta-script',    label: 'CTA script text',           type: 'text' },
      { id: 'cta-heading',   label: 'CTA heading',               type: 'text' },
    ],
  },
  'about.html': {
    label: 'About',
    zones: [
      { id: 'about-intro-p1',     label: 'Opening paragraph 1',          type: 'multiline' },
      { id: 'about-intro-p2',     label: 'Opening paragraph 2',          type: 'multiline' },
      { id: 'photographer-name',  label: 'Photographer name',            type: 'text' },
      { id: 'photographer-title', label: 'Photographer title',           type: 'text' },
      { id: 'photographer-bio-1', label: 'Photographer bio paragraph 1', type: 'multiline' },
      { id: 'photographer-bio-2', label: 'Photographer bio paragraph 2', type: 'multiline' },
      { id: 'pullquote',          label: 'Pull quote',                   type: 'multiline' },
      { id: 'pullquote-cite',     label: 'Pull quote attribution',       type: 'text' },
    ],
  },
  'services.html': {
    label: 'Services',
    zones: [
      { id: 'services-intro-body', label: 'Services intro paragraph', type: 'multiline' },
      { id: 'service-1-title',     label: 'Service 01 title',         type: 'text' },
      { id: 'service-1-body',      label: 'Service 01 description',   type: 'multiline' },
      { id: 'service-2-title',     label: 'Service 02 title',         type: 'text' },
      { id: 'service-2-body',      label: 'Service 02 description',   type: 'multiline' },
      { id: 'service-3-title',     label: 'Service 03 title',         type: 'text' },
      { id: 'service-3-body',      label: 'Service 03 description',   type: 'multiline' },
      { id: 'service-4-title',     label: 'Service 04 title',         type: 'text' },
      { id: 'service-4-body',      label: 'Service 04 description',   type: 'multiline' },
      { id: 'service-5-title',     label: 'Service 05 title',         type: 'text' },
      { id: 'service-5-body',      label: 'Service 05 description',   type: 'multiline' },
    ],
  },
  'contact.html': {
    label: 'Contact',
    zones: [
      { id: 'contact-intro-body',       label: 'Contact intro paragraph', type: 'multiline' },
      { id: 'contact-location',         label: 'Location',                type: 'text' },
      { id: 'contact-email',            label: 'Email address',           type: 'text' },
      { id: 'contact-response-heading', label: 'Response time heading',   type: 'text' },
      { id: 'contact-response-detail',  label: 'Response time detail',    type: 'multiline' },
    ],
  },
};

// ── GitHub API helpers ────────────────────────────────────────────────────────

async function ghFetch(path, options = {}, token) {
  return fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CTC-CMS/1.0',
      ...options.headers,
    },
  });
}

async function getFileData(file, token, ref, branch = 'master') {
  // ref wins (historical fetch by commit SHA); otherwise read from the target branch
  const qs  = `?ref=${ref ?? branch}`;
  const res = await ghFetch(`/repos/${GITHUB_REPO}/contents/site/${file}${qs}`, {}, token);
  if (!res.ok) return null;
  const data = await res.json();
  const text = atob(data.content.replace(/\n/g, ''));
  return { html: text, sha: data.sha };
}

async function putFileData(file, content, sha, message, token, branch = 'master') {
  // btoa requires latin-1; use encodeURIComponent + unescape for unicode safety
  const encoded = btoa(unescape(encodeURIComponent(content)));
  return ghFetch(
    `/repos/${GITHUB_REPO}/contents/site/${file}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: encoded, sha, branch }),
    },
    token,
  );
}

async function getFileHistory(file, token, branch = 'master') {
  const res = await ghFetch(
    `/repos/${GITHUB_REPO}/commits?path=site/${file}&per_page=10&sha=${branch}`,
    {},
    token,
  );
  if (!res.ok) return [];
  return res.json();
}

// ── Content extraction / injection ───────────────────────────────────────────

function extractZone(html, zoneId) {
  const m = html.match(
    new RegExp(`data-content-id="${zoneId}"[^>]*>([\\s\\S]*?)<\\/[a-z0-9]+>`, 'i'),
  );
  return m ? m[1].trim() : '';
}

function updateZone(html, zoneId, value) {
  return html.replace(
    new RegExp(`(data-content-id="${zoneId}"[^>]*>)[\\s\\S]*?(<\\/[a-z0-9]+>)`, 'i'),
    `$1${value}$2`,
  );
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export async function handleAdminCmsPages(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();

  return jsonResponse(
    Object.entries(PAGES).map(([file, cfg]) => ({
      file,
      label: cfg.label,
      zoneCount: cfg.zones.length,
    })),
  );
}

export async function handleAdminCmsPage(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();

  if (!env.CMS_GITHUB_TOKEN) return jsonResponse({ error: 'CMS_GITHUB_TOKEN not configured' }, 503);

  const url  = new URL(request.url);
  const file = url.searchParams.get('file');
  if (!file || !PAGES[file]) return jsonResponse({ error: 'Unknown page' }, 400);
  const cfg = PAGES[file];

  const branch = env.CMS_BRANCH ?? 'master';

  // ── GET: read current zone values ─────────────────────────────────────────
  if (request.method === 'GET') {
    const fileData = await getFileData(file, env.CMS_GITHUB_TOKEN, undefined, branch);
    if (!fileData) return jsonResponse({ error: 'Failed to fetch file from GitHub' }, 502);
    return jsonResponse({
      file,
      label: cfg.label,
      sha: fileData.sha,
      zones: cfg.zones.map(z => ({ ...z, value: extractZone(fileData.html, z.id) })),
    });
  }

  // ── PUT: save zone updates ────────────────────────────────────────────────
  if (request.method === 'PUT') {
    const { zones: updates } = await request.json();
    if (!updates) return jsonResponse({ error: 'Missing zones' }, 400);

    // Fetch a fresh SHA immediately before writing to avoid stale-SHA 409s
    const fileData = await getFileData(file, env.CMS_GITHUB_TOKEN, undefined, branch);
    if (!fileData) return jsonResponse({ error: 'Failed to fetch file from GitHub' }, 502);

    let html = fileData.html;
    const changedLabels = [];
    for (const [zoneId, value] of Object.entries(updates)) {
      const zone = cfg.zones.find(z => z.id === zoneId);
      if (!zone) continue;
      if (extractZone(html, zoneId) === String(value).trim()) continue;
      html = updateZone(html, zoneId, value);
      changedLabels.push(zone.label);
    }

    if (changedLabels.length === 0) return jsonResponse({ ok: true, message: 'No changes' });

    const commitMsg = `Update ${changedLabels.join(', ')} on ${cfg.label} page`;
    const res = await putFileData(file, html, fileData.sha, commitMsg, env.CMS_GITHUB_TOKEN, branch);
    if (!res.ok) {
      const err = await res.text();
      return jsonResponse({ error: `GitHub write failed: ${err}` }, 502);
    }
    const result = await res.json();
    return jsonResponse({ ok: true, message: commitMsg, commit: result.commit?.sha });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

export async function handleAdminCmsHistory(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();

  if (!env.CMS_GITHUB_TOKEN) return jsonResponse({ error: 'CMS_GITHUB_TOKEN not configured' }, 503);

  const url  = new URL(request.url);
  const file = url.searchParams.get('file');
  if (!file || !PAGES[file]) return jsonResponse({ error: 'Unknown page' }, 400);

  const branch = env.CMS_BRANCH ?? 'master';
  const commits = await getFileHistory(file, env.CMS_GITHUB_TOKEN, branch);
  return jsonResponse(commits.map(c => ({
    sha:     c.sha,
    message: c.commit?.message,
    author:  c.commit?.author?.name,
    date:    c.commit?.author?.date,
    url:     c.html_url,
  })));
}

export async function handleAdminCmsRevert(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();

  if (!env.CMS_GITHUB_TOKEN) return jsonResponse({ error: 'CMS_GITHUB_TOKEN not configured' }, 503);

  const { file, sha } = await request.json();
  if (!file || !sha || !PAGES[file]) return jsonResponse({ error: 'Missing file or sha' }, 400);

  const branch = env.CMS_BRANCH ?? 'master';

  const historical = await getFileData(file, env.CMS_GITHUB_TOKEN, sha, branch);
  if (!historical) return jsonResponse({ error: 'Could not fetch historical version' }, 502);

  const current = await getFileData(file, env.CMS_GITHUB_TOKEN, undefined, branch);
  if (!current) return jsonResponse({ error: 'Could not fetch current file' }, 502);

  const cfg     = PAGES[file];
  const message = `Revert ${cfg.label} page to ${sha.slice(0, 7)}`;
  const res     = await putFileData(file, historical.html, current.sha, message, env.CMS_GITHUB_TOKEN, branch);
  if (!res.ok) {
    const err = await res.text();
    return jsonResponse({ error: `GitHub write failed: ${err}` }, 502);
  }
  return jsonResponse({ ok: true, message });
}
