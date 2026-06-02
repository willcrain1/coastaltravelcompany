import { jsonResponse } from './utils.js';

function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(s) {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice(0, pad);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function createJWT(payload, secret) {
  const enc    = v => b64urlEncode(new TextEncoder().encode(JSON.stringify(v)));
  const header = enc({ alg: 'HS256', typ: 'JWT' });
  const body   = enc(payload);
  const input  = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return `${input}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('bad format');
  const [header, body, sig] = parts;
  const input = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    'HMAC', key, b64urlDecode(sig), new TextEncoder().encode(input)
  );
  if (!valid) throw new Error('bad signature');
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('expired');
  return payload;
}

export async function getAuth(request, env) {
  if (!env.JWT_SECRET) return null;
  // Authorization header takes precedence (masquerade sessions, Playwright, API clients)
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    try { return await verifyJWT(auth.slice(7), env.JWT_SECRET); } catch { return null; }
  }
  // Fall back to HttpOnly cookie for browser sessions
  const cookie = request.headers.get('Cookie') || '';
  const match  = cookie.match(/(?:^|;\s*)auth_token=([^;]+)/);
  if (match) {
    try { return await verifyJWT(match[1], env.JWT_SECRET); } catch { return null; }
  }
  return null;
}

export function makeAuthCookie(token, maxAge = 604800) {
  return `auth_token=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAge}`;
}

export function clearAuthCookie() {
  return 'auth_token=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0';
}
