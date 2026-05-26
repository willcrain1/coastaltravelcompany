import { describe, it, expect } from 'vitest';
import { jsonResponse, authRequired, forbidden, escHtml } from '../src/utils.js';

describe('jsonResponse', () => {
  it('returns 200 with JSON body by default', async () => {
    const res = jsonResponse({ ok: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it('accepts a custom status code', async () => {
    expect(jsonResponse({ error: 'x' }, 404).status).toBe(404);
  });
  it('sets Content-Type to application/json', () => {
    expect(jsonResponse({}).headers.get('Content-Type')).toBe('application/json');
  });
  it('includes CORS headers', () => {
    expect(jsonResponse({}).headers.get('Access-Control-Allow-Origin')).toBeTruthy();
  });
});

describe('authRequired', () => {
  it('returns 401', async () => {
    const res = authRequired();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/authentication required/i);
  });
});

describe('forbidden', () => {
  it('returns 403', async () => {
    const res = forbidden();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/forbidden/i);
  });
});

describe('escHtml', () => {
  it('escapes & < > "', () => {
    expect(escHtml('a & b < c > "d"')).toBe('a &amp; b &lt; c &gt; &quot;d&quot;');
  });
  it('returns empty string for null', () => { expect(escHtml(null)).toBe(''); });
  it('returns empty string for undefined', () => { expect(escHtml(undefined)).toBe(''); });
  it('returns empty string for empty string', () => { expect(escHtml('')).toBe(''); });
  it('passes through safe strings unchanged', () => {
    expect(escHtml('Hello World 123')).toBe('Hello World 123');
  });
});
