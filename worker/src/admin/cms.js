import { jsonResponse } from '../utils.js';
import { getAuth } from '../jwt.js';

const GITHUB_OWNER  = 'willcrain1';
const GITHUB_REPO   = 'coastaltravelcompany';
const GITHUB_BRANCH = 'master';
const GITHUB_API    = 'https://api.github.com';

export const CMS_PAGES = [
  { path: 'site/index.html',    label: 'Home'     },
  { path: 'site/about.html',    label: 'About'    },
  { path: 'site/services.html', label: 'Services' },
  { path: 'site/contact.html',  label: 'Contact'  },
];

// ── GitHub API helper ─────────────────────────────────────────────────────────

async function ghFetch(apiPath, options = {}, token) {
  return fetch(`${GITHUB_API}${apiPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CTC-CMS-Worker',
      ...options.headers,
    },
  });
}

async function fetchGitHubFile(path, token) {
  const res = await ghFetch(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`,
    { method: 'GET' },
    token,
  );
  if (!res.ok) return { error: res.status };
  const data = await res.json();
  // Decode base64 → UTF-8 safely (atob gives a binary string; TextDecoder handles multi-byte chars)
  const content = new TextDecoder('utf-8').decode(
    Uint8Array.from(atob(data.content.replace(/\n/g, '')), c => c.charCodeAt(0)),
  );
  return { content, sha: data.sha };
}

// ── Zone extraction & update ──────────────────────────────────────────────────

function extractZones(html) {
  const zones = [];
  // Match any element with a data-content-id attribute; use backreference to match closing tag.
  // Zones must be leaf elements (no nested child elements with the same tag) by design.
  const re = /<(\w+)([^>]*)\sdata-content-id="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, tagName, , id, , rawContent] = m;
    const tag   = tagName.toLowerCase();
    const type  = ['p', 'blockquote', 'div'].includes(tag) ? 'multiline' : 'text';
    zones.push({ id, tagName: tag, type, value: rawContent.trim() });
  }
  return zones;
}

function applyUpdates(html, updates) {
  let result = html;
  for (const [id, newValue] of Object.entries(updates)) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Capture (1) full opening tag, (2) tag name for backreference in close tag, (3) close tag
    const re = new RegExp(
      `(<(\\w+)[^>]*\\sdata-content-id="${esc}"[^>]*>)[\\s\\S]*?(<\\/\\2>)`,
      'i',
    );
    result = result.replace(re, (_, openTag, _tag, closeTag) =>
      `${openTag}${newValue}${closeTag}`,
    );
  }
  return result;
}

// ── Auth helper ───────────────────────────────────────────────────────────────

async function adminAuth(request, env) {
  const p = await getAuth(request, env);
  if (!p) return { err: jsonResponse({ error: 'Authentication required' }, 401) };
  if (p.role !== 'admin') return { err: jsonResponse({ error: 'Forbidden' }, 403) };
  if (!env.GITHUB_TOKEN) return { err: jsonResponse({ error: 'GITHUB_TOKEN not configured' }, 500) };
  return { p };
}

function labelFromId(id) {
  return id
    .replace(/^[a-z]+-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ── Route handlers ────────────────────────────────────────────────────────────

export async function handleAdminCmsPages(request, env) {
  const { err } = await adminAuth(request, env);
  if (err) return err;
  return jsonResponse(CMS_PAGES);
}

export async function handleAdminCmsContent(request, env) {
  const { err } = await adminAuth(request, env);
  if (err) return err;

  const pagePath = new URL(request.url).searchParams.get('page');
  const pg = CMS_PAGES.find(p => p.path === pagePath);
  if (!pg) return jsonResponse({ error: 'Unknown page' }, 400);

  const file = await fetchGitHubFile(pg.path, env.GITHUB_TOKEN);
  if (file.error) return jsonResponse({ error: `GitHub error: ${file.error}` }, 502);

  const zones = extractZones(file.content);
  return jsonResponse({
    page: pg.path,
    label: pg.label,
    sha: file.sha,
    rawHtml: file.content,
    zones: zones.map(z => ({ ...z, label: labelFromId(z.id) })),
  });
}

export async function handleAdminCmsSave(request, env) {
  const { err } = await adminAuth(request, env);
  if (err) return err;

  const { page: pagePath, updates, message } = await request.json();
  const pg = CMS_PAGES.find(p => p.path === pagePath);
  if (!pg || !updates) return jsonResponse({ error: 'page and updates required' }, 400);

  const file = await fetchGitHubFile(pg.path, env.GITHUB_TOKEN);
  if (file.error) return jsonResponse({ error: 'Failed to fetch current file' }, 502);

  const updated   = applyUpdates(file.content, updates);
  const commitMsg = message || `Update ${pg.label} content`;

  // Encode UTF-8 → base64
  const encoded = btoa(
    String.fromCharCode(...new TextEncoder().encode(updated)),
  );

  const putRes = await ghFetch(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${pg.path}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMsg,
        content: encoded,
        sha: file.sha,
        branch: GITHUB_BRANCH,
      }),
    },
    env.GITHUB_TOKEN,
  );

  if (!putRes.ok) {
    const detail = await putRes.text();
    return jsonResponse({ error: 'Commit failed', detail }, 502);
  }

  const putData = await putRes.json();
  return jsonResponse({
    ok: true,
    commit: {
      sha:     putData.commit.sha,
      message: putData.commit.message,
      url:     putData.commit.html_url,
    },
  });
}

export async function handleAdminCmsDeployment(request, env) {
  const { err } = await adminAuth(request, env);
  if (err) return err;

  const res = await ghFetch(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pages/builds/latest`,
    { method: 'GET' },
    env.GITHUB_TOKEN,
  );
  if (!res.ok) return jsonResponse({ status: 'unknown' });
  const build = await res.json();
  return jsonResponse({
    status:     build.status,
    updated_at: build.updated_at,
    commit:     build.commit,
  });
}

export async function handleAdminCmsHistory(request, env) {
  const { err } = await adminAuth(request, env);
  if (err) return err;

  const pagePath = new URL(request.url).searchParams.get('page');
  const pg = CMS_PAGES.find(p => p.path === pagePath);
  if (!pg) return jsonResponse({ error: 'Unknown page' }, 400);

  const res = await ghFetch(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits?path=${encodeURIComponent(pg.path)}&per_page=10&sha=${GITHUB_BRANCH}`,
    { method: 'GET' },
    env.GITHUB_TOKEN,
  );
  if (!res.ok) return jsonResponse({ commits: [] });

  const commits = await res.json();
  return jsonResponse({
    commits: commits.map(c => ({
      sha:     c.sha,
      message: c.commit.message,
      author:  c.commit.author.name,
      date:    c.commit.author.date,
      url:     c.html_url,
    })),
  });
}

export async function handleAdminCmsRevert(request, env) {
  const { err } = await adminAuth(request, env);
  if (err) return err;

  const { page: pagePath, commitSha } = await request.json();
  const pg = CMS_PAGES.find(p => p.path === pagePath);
  if (!pg || !commitSha) return jsonResponse({ error: 'page and commitSha required' }, 400);

  // Fetch historical version of the file
  const histRes = await ghFetch(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${pg.path}?ref=${commitSha}`,
    { method: 'GET' },
    env.GITHUB_TOKEN,
  );
  if (!histRes.ok) return jsonResponse({ error: 'Could not fetch historical version' }, 502);
  const historical = await histRes.json();

  // Get current SHA to create the reverting commit
  const current = await fetchGitHubFile(pg.path, env.GITHUB_TOKEN);
  if (current.error) return jsonResponse({ error: 'Failed to fetch current file' }, 502);

  const putRes = await ghFetch(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${pg.path}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Revert ${pg.label} to ${commitSha.slice(0, 7)}`,
        content: historical.content.replace(/\n/g, ''),
        sha:     current.sha,
        branch:  GITHUB_BRANCH,
      }),
    },
    env.GITHUB_TOKEN,
  );

  if (!putRes.ok) {
    const detail = await putRes.text();
    return jsonResponse({ error: 'Revert failed', detail }, 502);
  }

  const putData = await putRes.json();
  return jsonResponse({
    ok: true,
    commit: { sha: putData.commit.sha, url: putData.commit.html_url },
  });
}
