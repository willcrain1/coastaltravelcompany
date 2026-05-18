// ── Constants ──────────────────────────────────────────────────────────────────
const JWT_KEY    = 'ctc_jwt';
const USER_KEY   = 'ctc_user';
const LEGACY_KEY = 'ctc_galleries_v1';

// ── Worker URL ─────────────────────────────────────────────────────────────────
function getWorkerUrl() { return CTC_CONFIG.workerUrl; }
function token() { return localStorage.getItem(JWT_KEY) || ''; }

// ── API helper ─────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const url = getWorkerUrl() + path;
  const headers = { 'Authorization': 'Bearer ' + token(), ...opts.headers };
  if (opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { ...opts, headers });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// ── Auth gate ──────────────────────────────────────────────────────────────────
async function authGate() {
  const tok = token();
  if (!tok) { window.location.href = '/login.html'; return false; }
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

function signOut() {
  localStorage.removeItem(JWT_KEY);
  localStorage.removeItem(USER_KEY);
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
