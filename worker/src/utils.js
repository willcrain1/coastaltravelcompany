import { CORS } from './constants.js';

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export function authRequired() { return jsonResponse({ error: 'Authentication required' }, 401); }
export function forbidden()    { return jsonResponse({ error: 'Forbidden' }, 403); }

export function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
