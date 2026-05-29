const LOGIN_MAX_EMAIL       = 5;    // per-email failures before lockout
const LOGIN_MAX_IP          = 20;   // per-IP failures before lockout
const LOGIN_TTL             = 900;  // 15 minutes

const ADMIN_ALERT_THRESHOLD = 3;    // send alert after N admin failures
const ADMIN_LOCKOUT         = 5;    // permanent lockout threshold for admin accounts

const RESET_MAX_EMAIL = 3;          // reset requests per email per hour
const RESET_MAX_IP    = 10;         // reset requests per IP per hour
const RESET_TTL       = 3600;       // 1 hour

const GALLERY_MAX_IP = 10;          // failed token exchanges per IP
const GALLERY_TTL    = 600;         // 10 minutes

const ALERT_TO = 'thecoastaltravelcompany@gmail.com';

async function getCount(kv, key) {
  const v = await kv.get(key);
  return v ? parseInt(v, 10) : 0;
}

async function increment(kv, key, ttl) {
  const count = (await getCount(kv, key)) + 1;
  await kv.put(key, String(count), { expirationTtl: ttl });
  return count;
}

// ── Login ─────────────────────────────────────────────────────────────────────

export async function checkLoginBruteForce(email, ip, kv) {
  const permanentLock = await kv.get(`locked:${email}`);
  if (permanentLock) {
    return { locked: true, reason: 'Account locked due to repeated failed attempts. Please reset your password to regain access.' };
  }
  const byEmail = await getCount(kv, `brute:email:${email}`);
  if (byEmail >= LOGIN_MAX_EMAIL) {
    return { locked: true, reason: 'Too many failed login attempts. Please try again in 15 minutes.' };
  }
  const byIp = await getCount(kv, `brute:ip:${ip}`);
  if (byIp >= LOGIN_MAX_IP) {
    return { locked: true, reason: 'Too many requests from your network. Please try again in 15 minutes.' };
  }
  return { locked: false };
}

export async function recordLoginFailure(email, ip, role, kv, resendApiKey) {
  const emailCount = await increment(kv, `brute:email:${email}`, LOGIN_TTL);
  await increment(kv, `brute:ip:${ip}`, LOGIN_TTL);

  if (role === 'admin') {
    if (emailCount >= ADMIN_LOCKOUT) {
      // permanent — no TTL; cleared only by successful password reset
      await kv.put(`locked:${email}`, '1');
    }
    if (emailCount >= ADMIN_ALERT_THRESHOLD && resendApiKey) {
      sendAdminAlert(email, ip, emailCount, resendApiKey).catch(() => {});
    }
  }
}

export async function clearLoginCounters(email, ip, kv) {
  await Promise.all([
    kv.delete(`brute:email:${email}`),
    kv.delete(`brute:ip:${ip}`),
  ]);
}

// ── Password reset ────────────────────────────────────────────────────────────

export async function checkResetBruteForce(email, ip, kv) {
  const byEmail = await getCount(kv, `brute:reset:${email}`);
  if (byEmail >= RESET_MAX_EMAIL) return { locked: true };
  const byIp = await getCount(kv, `brute:reset:ip:${ip}`);
  if (byIp >= RESET_MAX_IP) return { locked: true };
  return { locked: false };
}

export async function recordResetAttempt(email, ip, kv) {
  await Promise.all([
    increment(kv, `brute:reset:${email}`, RESET_TTL),
    increment(kv, `brute:reset:ip:${ip}`, RESET_TTL),
  ]);
}

// ── Gallery token exchange ────────────────────────────────────────────────────

export async function checkGalleryUnlockBruteForce(ip, kv) {
  const count = await getCount(kv, `brute:gallery:ip:${ip}`);
  return count >= GALLERY_MAX_IP;
}

export async function recordGalleryUnlockFailure(ip, kv) {
  await increment(kv, `brute:gallery:ip:${ip}`, GALLERY_TTL);
}

export async function clearGalleryUnlockCounter(ip, kv) {
  await kv.delete(`brute:gallery:ip:${ip}`);
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function sendAdminAlert(email, ip, count, resendApiKey) {
  await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
      to:      [ALERT_TO],
      subject: `[Security] Failed admin login — ${email}`,
      html:    `<p style="font-family:sans-serif">Failed admin login attempts detected.</p>
<p style="font-family:sans-serif"><strong>Account:</strong> ${email}<br>
<strong>Attempts:</strong> ${count}<br>
<strong>IP:</strong> ${ip}</p>
<p style="font-family:sans-serif;color:#999">This is an automated security alert from Coastal Travel Company.</p>`,
    }),
  });
}
