import { describe, it, expect } from 'vitest';
import { jsonResponse, rateLimitedResponse, authRequired, forbidden, escHtml } from '../src/utils.js';

describe('jsonResponse', () => {
  it('returns 200 by default with JSON body', async () => {
    const res = jsonResponse({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('accepts a custom status code', async () => {
    const res = jsonResponse({ error: 'not found' }, 404);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not found');
  });

  it('includes CORS headers', () => {
    const res = jsonResponse({});
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
  });
});

describe('rateLimitedResponse', () => {
  it('returns 429 with Retry-After header', async () => {
    const res = rateLimitedResponse('Too many requests', 60);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    const body = await res.json();
    expect(body.error).toBe('Too many requests');
  });

  it('includes CORS headers', () => {
    const res = rateLimitedResponse('rate limited', 30);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
  });
});

describe('authRequired', () => {
  it('returns 401 with error message', async () => {
    const res = authRequired();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/authentication required/i);
  });
});

describe('forbidden', () => {
  it('returns 403 with error message', async () => {
    const res = forbidden();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/forbidden/i);
  });
});

describe('escHtml', () => {
  it('escapes ampersands', () => {
    expect(escHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes double quotes', () => {
    expect(escHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('handles empty string', () => {
    expect(escHtml('')).toBe('');
  });

  it('handles null/undefined by returning empty string', () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });

  it('leaves safe characters intact', () => {
    expect(escHtml('Hello World 123')).toBe('Hello World 123');
  });

  it('handles XSS payload', () => {
    const xss = '<script>alert("xss")</script>';
    const result = escHtml(xss);
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('"xss"');
    expect(result).toContain('&lt;script&gt;');
  });
});
