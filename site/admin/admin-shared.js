// ── Constants ──────────────────────────────────────────────────────────────────
const JWT_KEY    = 'ctc_jwt';
const USER_KEY   = 'ctc_user';
const LEGACY_KEY = 'ctc_galleries_v1';

// ── Worker URL ─────────────────────────────────────────────────────────────────
function getWorkerUrl() { return CTC_CONFIG.workerUrl; }

// ── API helper ─────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const url = getWorkerUrl() + path;
  const headers = { ...opts.headers };
  if (opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  // Include stored JWT as Bearer token — fallback for browsers that block
  // cross-origin cookies (.workers.dev is a different eTLD+1 from the static site).
  // The server accepts either cookie or Bearer; cookie is preferred when both present.
  const jwt = localStorage.getItem(JWT_KEY);
  if (jwt && !headers['Authorization']) headers['Authorization'] = 'Bearer ' + jwt;
  const res = await fetch(url, { ...opts, headers, credentials: 'include' });
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

// ── Auth gate ──────────────────────────────────────────────────────────────────
async function authGate() {
  try {
    const { ok, data } = await apiFetch('/auth/me', { method: 'GET' });
    if (!ok) { window.location.href = '/login.html'; return false; }
    if (data.role !== 'admin') { window.location.href = '/portal.html'; return false; }
    document.getElementById('adminEmail').textContent = data.email;
    highlightNav();
    return true;
  } catch {
    window.location.href = '/login.html';
    return false;
  }
}

async function signOut() {
  localStorage.removeItem(JWT_KEY);
  localStorage.removeItem(USER_KEY);
  await fetch(getWorkerUrl() + '/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
  window.location.href = '/login.html';
}

// ── Settings ───────────────────────────────────────────────────────────────────
function getSettings() {
  return {
    mainSiteUrl:  CTC_CONFIG.mainSiteUrl,
    nasClientUrl: CTC_CONFIG.nasClientUrl,
    workerUrl:    CTC_CONFIG.workerUrl,
  };
}

// ── HTML escaping ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Toast notifications ────────────────────────────────────────────────────────
let toastTmr;
function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTmr);
  toastTmr = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── Nav highlight ──────────────────────────────────────────────────────────────
function highlightNav() {
  const page = location.pathname.split('/').pop();
  document.querySelectorAll('.admin-nav-link').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === page);
  });
}
