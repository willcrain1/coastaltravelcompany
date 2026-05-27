import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  handleAdminCmsPages,
  handleAdminCmsPage,
  handleAdminCmsHistory,
  handleAdminCmsRevert,
} from '../../src/admin/cms.js';
import { createJWT } from '../../src/jwt.js';

const SECRET = 'test-jwt-secret-at-least-32-chars!!';

// Minimal HTML that contains every data-content-id used by index.html zones
const INDEX_HTML = [
  '<html><body>',
  '<p data-content-id="hero-eyebrow">Palm Beach, Florida</p>',
  '<span data-content-id="hero-script">Coastal</span>',
  '<h1 data-content-id="hero-title">Travel Company</h1>',
  '<p data-content-id="hero-tagline">Desired, not just seen.</p>',
  '<p data-content-id="intro-body">Coastal Travel Company creates refined visuals.</p>',
  '<blockquote data-content-id="pullquote">We create work.</blockquote>',
  '<cite data-content-id="pullquote-cite">The Philosophy</cite>',
  '<span data-content-id="cta-script">let\'s work together</span>',
  '<h2 data-content-id="cta-heading">Ready to Elevate?</h2>',
  '</body></html>',
].join('\n');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEnv({ token = 'ghp_test', noGitHub = false, branch = 'master' } = {}) {
  const store = new Map();
  return {
    KV: {
      get:    async k      => store.get(k) ?? null,
      put:    async (k, v) => { store.set(k, v); },
      delete: async k      => { store.delete(k); },
    },
    JWT_SECRET:   SECRET,
    CMS_GITHUB_TOKEN: noGitHub ? undefined : token,
    CMS_BRANCH:   branch,
  };
}

async function adminReq(method, url = 'http://t/', body) {
  const tok = await createJWT(
    { sub: 'a@t.com', id: 'aid', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET,
  );
  return new Request(url, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function clientReq(method, url = 'http://t/') {
  const tok = await createJWT(
    { sub: 'c@t.com', role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET,
  );
  return new Request(url, { method, headers: { Authorization: `Bearer ${tok}` } });
}

// Build a mock fetch that returns a GitHub "get file" response for GET calls
// and a "put file" success for PUT calls.
function mockGitHub({ html = INDEX_HTML, sha = 'sha123', commitSha = 'commit456', getOk = true, putOk = true, commitsOk = true, commits = [] } = {}) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url, opts = {}) => {
    if (opts.method === 'PUT') {
      if (!putOk) return { ok: false, text: async () => 'GitHub error' };
      return { ok: true, json: async () => ({ commit: { sha: commitSha }, content: { sha: 'newsha' } }) };
    }
    // GET — could be contents or commits
    if (String(url).includes('/commits')) {
      if (!commitsOk) return { ok: false };
      return { ok: true, json: async () => commits };
    }
    if (!getOk) return { ok: false };
    return { ok: true, json: async () => ({ content: btoa(html), sha }) };
  }));
}

afterEach(() => vi.unstubAllGlobals());

// ── handleAdminCmsPages ───────────────────────────────────────────────────────

describe('handleAdminCmsPages', () => {
  it('401 when unauthenticated', async () => {
    const r = await handleAdminCmsPages(new Request('http://t/', { method: 'GET' }), makeEnv());
    expect(r.status).toBe(401);
  });

  it('403 for client role', async () => {
    const r = await handleAdminCmsPages(await clientReq('GET'), makeEnv());
    expect(r.status).toBe(403);
  });

  it('200 returns page list with file/label/zoneCount', async () => {
    const r    = await handleAdminCmsPages(await adminReq('GET'), makeEnv());
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    const home = body.find(p => p.file === 'index.html');
    expect(home).toBeDefined();
    expect(home.label).toBe('Home');
    expect(typeof home.zoneCount).toBe('number');
    expect(home.zoneCount).toBeGreaterThan(0);
  });

  it('includes all four instrumented pages', async () => {
    const r    = await handleAdminCmsPages(await adminReq('GET'), makeEnv());
    const body = await r.json();
    const files = body.map(p => p.file);
    expect(files).toContain('index.html');
    expect(files).toContain('about.html');
    expect(files).toContain('services.html');
    expect(files).toContain('contact.html');
  });
});

// ── handleAdminCmsPage GET ────────────────────────────────────────────────────

describe('handleAdminCmsPage GET', () => {
  const url = 'http://t/admin/cms/page?file=index.html';

  it('401 when unauthenticated', async () => {
    const r = await handleAdminCmsPage(new Request(url, { method: 'GET' }), makeEnv());
    expect(r.status).toBe(401);
  });

  it('403 for client role', async () => {
    const r = await handleAdminCmsPage(await clientReq('GET', url), makeEnv());
    expect(r.status).toBe(403);
  });

  it('503 when CMS_GITHUB_TOKEN is missing', async () => {
    const r = await handleAdminCmsPage(await adminReq('GET', url), makeEnv({ noGitHub: true }));
    expect(r.status).toBe(503);
  });

  it('400 for unknown page file', async () => {
    const r = await handleAdminCmsPage(
      await adminReq('GET', 'http://t/admin/cms/page?file=nonexistent.html'),
      makeEnv(),
    );
    expect(r.status).toBe(400);
  });

  it('400 when file param is missing', async () => {
    const r = await handleAdminCmsPage(
      await adminReq('GET', 'http://t/admin/cms/page'),
      makeEnv(),
    );
    expect(r.status).toBe(400);
  });

  it('502 when GitHub fetch fails', async () => {
    mockGitHub({ getOk: false });
    const r = await handleAdminCmsPage(await adminReq('GET', url), makeEnv());
    expect(r.status).toBe(502);
  });

  it('200 returns zones with extracted values', async () => {
    mockGitHub();
    const r    = await handleAdminCmsPage(await adminReq('GET', url), makeEnv());
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.file).toBe('index.html');
    expect(body.label).toBe('Home');
    expect(body.sha).toBe('sha123');
    expect(Array.isArray(body.zones)).toBe(true);
    const eyebrow = body.zones.find(z => z.id === 'hero-eyebrow');
    expect(eyebrow).toBeDefined();
    expect(eyebrow.value).toBe('Palm Beach, Florida');
    const tagline = body.zones.find(z => z.id === 'hero-tagline');
    expect(tagline.value).toBe('Desired, not just seen.');
  });

  it('returns empty string for a zone not present in the HTML', async () => {
    mockGitHub({ html: '<html><body></body></html>' });
    const r    = await handleAdminCmsPage(await adminReq('GET', url), makeEnv());
    const body = await r.json();
    const eyebrow = body.zones.find(z => z.id === 'hero-eyebrow');
    expect(eyebrow.value).toBe('');
  });
});

// ── handleAdminCmsPage PUT ────────────────────────────────────────────────────

describe('handleAdminCmsPage PUT', () => {
  const url = 'http://t/admin/cms/page?file=index.html';

  it('401 when unauthenticated', async () => {
    const r = await handleAdminCmsPage(
      new Request(url, { method: 'PUT', body: '{}', headers: { 'Content-Type': 'application/json' } }),
      makeEnv(),
    );
    expect(r.status).toBe(401);
  });

  it('403 for client role', async () => {
    const r = await handleAdminCmsPage(await clientReq('PUT', url), makeEnv());
    expect(r.status).toBe(403);
  });

  it('503 when CMS_GITHUB_TOKEN is missing', async () => {
    const r = await handleAdminCmsPage(
      await adminReq('PUT', url, { zones: { 'hero-title': 'New Title' } }),
      makeEnv({ noGitHub: true }),
    );
    expect(r.status).toBe(503);
  });

  it('400 for unknown page', async () => {
    const r = await handleAdminCmsPage(
      await adminReq('PUT', 'http://t/admin/cms/page?file=unknown.html', { zones: {} }),
      makeEnv(),
    );
    expect(r.status).toBe(400);
  });

  it('400 when zones is missing from body', async () => {
    mockGitHub();
    const r = await handleAdminCmsPage(
      await adminReq('PUT', url, {}),
      makeEnv(),
    );
    expect(r.status).toBe(400);
  });

  it('200 with "No changes" when values are identical', async () => {
    mockGitHub();
    const r = await handleAdminCmsPage(
      await adminReq('PUT', url, { zones: { 'hero-eyebrow': 'Palm Beach, Florida' } }),
      makeEnv(),
    );
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toBe('No changes');
  });

  it('200 commits changed zones', async () => {
    mockGitHub();
    const r = await handleAdminCmsPage(
      await adminReq('PUT', url, { zones: { 'hero-title': 'New Title' } }),
      makeEnv(),
    );
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toContain('Hero main title');
    expect(body.commit).toBe('commit456');
  });

  it('skips unknown zone IDs silently', async () => {
    mockGitHub();
    const r = await handleAdminCmsPage(
      await adminReq('PUT', url, { zones: { 'nonexistent-zone': 'value' } }),
      makeEnv(),
    );
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.message).toBe('No changes');
  });

  it('502 when GitHub file fetch fails before PUT', async () => {
    mockGitHub({ getOk: false });
    const r = await handleAdminCmsPage(
      await adminReq('PUT', url, { zones: { 'hero-title': 'New' } }),
      makeEnv(),
    );
    expect(r.status).toBe(502);
  });

  it('502 when GitHub PUT fails', async () => {
    mockGitHub({ putOk: false });
    const r = await handleAdminCmsPage(
      await adminReq('PUT', url, { zones: { 'hero-title': 'New Title' } }),
      makeEnv(),
    );
    expect(r.status).toBe(502);
  });

  it('405 for unsupported method', async () => {
    const r = await handleAdminCmsPage(await adminReq('DELETE', url), makeEnv());
    expect(r.status).toBe(405);
  });
});

// ── handleAdminCmsHistory ─────────────────────────────────────────────────────

describe('handleAdminCmsHistory', () => {
  const url = 'http://t/admin/cms/history?file=index.html';

  it('401 when unauthenticated', async () => {
    const r = await handleAdminCmsHistory(new Request(url, { method: 'GET' }), makeEnv());
    expect(r.status).toBe(401);
  });

  it('403 for client role', async () => {
    const r = await handleAdminCmsHistory(await clientReq('GET', url), makeEnv());
    expect(r.status).toBe(403);
  });

  it('503 when CMS_GITHUB_TOKEN is missing', async () => {
    const r = await handleAdminCmsHistory(await adminReq('GET', url), makeEnv({ noGitHub: true }));
    expect(r.status).toBe(503);
  });

  it('400 for unknown page', async () => {
    const r = await handleAdminCmsHistory(
      await adminReq('GET', 'http://t/admin/cms/history?file=unknown.html'),
      makeEnv(),
    );
    expect(r.status).toBe(400);
  });

  it('400 when file param is missing', async () => {
    const r = await handleAdminCmsHistory(
      await adminReq('GET', 'http://t/admin/cms/history'),
      makeEnv(),
    );
    expect(r.status).toBe(400);
  });

  it('200 returns empty array when GitHub returns no commits', async () => {
    mockGitHub({ commits: [] });
    const r    = await handleAdminCmsHistory(await adminReq('GET', url), makeEnv());
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body).toEqual([]);
  });

  it('200 returns mapped commit history', async () => {
    const commits = [
      {
        sha: 'abc123',
        commit: { message: 'Update hero', author: { name: 'Admin', date: '2024-01-01T00:00:00Z' } },
        html_url: 'https://github.com/...',
      },
    ];
    mockGitHub({ commits });
    const r    = await handleAdminCmsHistory(await adminReq('GET', url), makeEnv());
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body[0].sha).toBe('abc123');
    expect(body[0].message).toBe('Update hero');
    expect(body[0].author).toBe('Admin');
    expect(body[0].date).toBe('2024-01-01T00:00:00Z');
  });

  it('200 returns empty array when GitHub commits endpoint fails', async () => {
    mockGitHub({ commitsOk: false });
    const r    = await handleAdminCmsHistory(await adminReq('GET', url), makeEnv());
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body).toEqual([]);
  });
});

// ── handleAdminCmsRevert ──────────────────────────────────────────────────────

describe('handleAdminCmsRevert', () => {
  const url = 'http://t/admin/cms/revert';

  it('401 when unauthenticated', async () => {
    const r = await handleAdminCmsRevert(
      new Request(url, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }),
      makeEnv(),
    );
    expect(r.status).toBe(401);
  });

  it('403 for client role', async () => {
    const r = await handleAdminCmsRevert(await clientReq('POST', url), makeEnv());
    expect(r.status).toBe(403);
  });

  it('503 when CMS_GITHUB_TOKEN is missing', async () => {
    const r = await handleAdminCmsRevert(
      await adminReq('POST', url, { file: 'index.html', sha: 'abc' }),
      makeEnv({ noGitHub: true }),
    );
    expect(r.status).toBe(503);
  });

  it('400 when file is missing', async () => {
    const r = await handleAdminCmsRevert(
      await adminReq('POST', url, { sha: 'abc123' }),
      makeEnv(),
    );
    expect(r.status).toBe(400);
  });

  it('400 when sha is missing', async () => {
    const r = await handleAdminCmsRevert(
      await adminReq('POST', url, { file: 'index.html' }),
      makeEnv(),
    );
    expect(r.status).toBe(400);
  });

  it('400 for unknown page file', async () => {
    const r = await handleAdminCmsRevert(
      await adminReq('POST', url, { file: 'unknown.html', sha: 'abc123' }),
      makeEnv(),
    );
    expect(r.status).toBe(400);
  });

  it('502 when historical GitHub fetch fails', async () => {
    // First fetch (historical) fails
    let call = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      call++;
      return { ok: false };
    }));
    const r = await handleAdminCmsRevert(
      await adminReq('POST', url, { file: 'index.html', sha: 'oldsha' }),
      makeEnv(),
    );
    expect(r.status).toBe(502);
  });

  it('502 when current GitHub fetch fails', async () => {
    // First fetch succeeds (historical), second fails (current)
    let call = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return { ok: true, json: async () => ({ content: btoa(INDEX_HTML), sha: 'hist' }) };
      return { ok: false };
    }));
    const r = await handleAdminCmsRevert(
      await adminReq('POST', url, { file: 'index.html', sha: 'oldsha' }),
      makeEnv(),
    );
    expect(r.status).toBe(502);
  });

  it('502 when GitHub PUT fails during revert', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url_, opts = {}) => {
      if (opts.method === 'PUT') return { ok: false, text: async () => 'fail' };
      call++;
      return { ok: true, json: async () => ({ content: btoa(INDEX_HTML), sha: `sha${call}` }) };
    }));
    const r = await handleAdminCmsRevert(
      await adminReq('POST', url, { file: 'index.html', sha: 'oldsha' }),
      makeEnv(),
    );
    expect(r.status).toBe(502);
  });

  it('200 creates a reverting commit', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url_, opts = {}) => {
      if (opts.method === 'PUT') {
        return { ok: true, json: async () => ({ commit: { sha: 'revert789' } }) };
      }
      call++;
      return { ok: true, json: async () => ({ content: btoa(INDEX_HTML), sha: `sha${call}` }) };
    }));
    const r    = await handleAdminCmsRevert(
      await adminReq('POST', url, { file: 'index.html', sha: 'oldsha12345678' }),
      makeEnv(),
    );
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toContain('Revert');
    expect(body.message).toContain('Home');
    expect(body.message).toContain('oldsha1'); // first 7 chars of sha
  });
});

// ── Branch routing ────────────────────────────────────────────────────────────

describe('branch routing', () => {
  it('GET page sends ?ref=master by default', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (u, opts = {}) => {
      calls.push({ url: String(u), method: opts.method });
      return { ok: true, json: async () => ({ content: btoa(INDEX_HTML), sha: 'sha1' }) };
    }));
    await handleAdminCmsPage(
      await adminReq('GET', 'http://t/admin/cms/page?file=index.html'),
      makeEnv(),
    );
    expect(calls[0].url).toContain('?ref=master');
  });

  it('GET page sends ?ref=preprod when CMS_BRANCH is preprod', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (u, opts = {}) => {
      calls.push({ url: String(u), method: opts.method });
      return { ok: true, json: async () => ({ content: btoa(INDEX_HTML), sha: 'sha1' }) };
    }));
    await handleAdminCmsPage(
      await adminReq('GET', 'http://t/admin/cms/page?file=index.html'),
      makeEnv({ branch: 'preprod' }),
    );
    expect(calls[0].url).toContain('?ref=preprod');
  });

  it('PUT page sends branch in the PUT body', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (u, opts = {}) => {
      if (opts.method === 'PUT') {
        bodies.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ commit: { sha: 'c1' }, content: { sha: 'ns' } }) };
      }
      return { ok: true, json: async () => ({ content: btoa(INDEX_HTML), sha: 'sha1' }) };
    }));
    await handleAdminCmsPage(
      await adminReq('PUT', 'http://t/admin/cms/page?file=index.html', {
        zones: { 'hero-title': 'Changed Title' },
      }),
      makeEnv({ branch: 'preprod' }),
    );
    expect(bodies[0].branch).toBe('preprod');
  });

  it('GET history sends &sha=master by default', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (u) => {
      calls.push(String(u));
      return { ok: true, json: async () => [] };
    }));
    await handleAdminCmsHistory(
      await adminReq('GET', 'http://t/admin/cms/history?file=index.html'),
      makeEnv(),
    );
    expect(calls[0]).toContain('&sha=master');
  });

  it('GET history sends &sha=preprod when CMS_BRANCH is preprod', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (u) => {
      calls.push(String(u));
      return { ok: true, json: async () => [] };
    }));
    await handleAdminCmsHistory(
      await adminReq('GET', 'http://t/admin/cms/history?file=index.html'),
      makeEnv({ branch: 'preprod' }),
    );
    expect(calls[0]).toContain('&sha=preprod');
  });

  it('revert historical fetch uses ?ref=<sha>, current uses ?ref=<branch>, PUT uses branch', async () => {
    const getUrls = [];
    const putBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (u, opts = {}) => {
      if (opts.method === 'PUT') {
        putBodies.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ commit: { sha: 'rev1' } }) };
      }
      getUrls.push(String(u));
      return { ok: true, json: async () => ({ content: btoa(INDEX_HTML), sha: 'currentsha' }) };
    }));
    await handleAdminCmsRevert(
      await adminReq('POST', 'http://t/admin/cms/revert', { file: 'index.html', sha: 'historicsha' }),
      makeEnv({ branch: 'preprod' }),
    );
    // First GET fetches historical content by commit sha
    expect(getUrls[0]).toContain('?ref=historicsha');
    // Second GET fetches current file on the branch
    expect(getUrls[1]).toContain('?ref=preprod');
    // PUT targets the correct branch
    expect(putBodies[0].branch).toBe('preprod');
  });
});
