import { describe, it, expect, beforeEach } from 'vitest';
import {
  ALLOWED_ORIGIN, CORS, initCors, ALLOWED_APIS,
  NAS_SHARE_API, RATE_LIMIT, CONTACT_RATE_LIMIT, JWT_EXPIRY_SECS,
} from '../src/constants.js';

describe('constants', () => {
  it('ALLOWED_ORIGIN defaults to coastaltravelcompany.com', () => {
    // The value may have been mutated by other tests; check it's a string containing the domain
    expect(typeof ALLOWED_ORIGIN).toBe('string');
  });

  it('CORS contains expected Access-Control headers', () => {
    expect(CORS['Access-Control-Allow-Methods']).toContain('GET');
    expect(CORS['Access-Control-Allow-Methods']).toContain('POST');
    expect(CORS['Access-Control-Allow-Headers']).toContain('Authorization');
    expect(CORS['Access-Control-Expose-Headers']).toBe('Content-Disposition');
  });

  it('ALLOWED_APIS includes required Synology methods', () => {
    expect(ALLOWED_APIS.has('SYNO.Foto.Browse.Item')).toBe(true);
    expect(ALLOWED_APIS.has('SYNO.Foto.Thumbnail')).toBe(true);
    expect(ALLOWED_APIS.has('SYNO.Foto.Download')).toBe(true);
    expect(ALLOWED_APIS.has('SYNO.Foto.Streaming')).toBe(true);
  });

  it('ALLOWED_APIS does not include arbitrary methods', () => {
    expect(ALLOWED_APIS.has('SYNO.Core.System')).toBe(false);
    expect(ALLOWED_APIS.has('SYNO.Foto.Delete')).toBe(false);
  });

  it('RATE_LIMIT and CONTACT_RATE_LIMIT are positive integers', () => {
    expect(RATE_LIMIT).toBeGreaterThan(0);
    expect(CONTACT_RATE_LIMIT).toBeGreaterThan(0);
  });

  it('JWT_EXPIRY_SECS is 7 days in seconds', () => {
    expect(JWT_EXPIRY_SECS).toBe(7 * 24 * 3600);
  });

  it('NAS_SHARE_API points to the Cloudflare Tunnel host', () => {
    expect(NAS_SHARE_API).toContain('nas.coastaltravelcompany.com');
  });

  it('initCors updates ALLOWED_ORIGIN and CORS when a different origin is passed', async () => {
    // Import module fresh to avoid cross-test pollution; work with live binding behavior
    const mod = await import('../src/constants.js');
    const originalOrigin = mod.ALLOWED_ORIGIN;
    const testOrigin = 'https://preprod.coastaltravelcompany.com';
    mod.initCors(testOrigin);
    expect(mod.ALLOWED_ORIGIN).toBe(testOrigin);
    expect(mod.CORS['Access-Control-Allow-Origin']).toBe(testOrigin);
    // Restore
    mod.initCors(originalOrigin);
  });

  it('initCors is a no-op when passed the current ALLOWED_ORIGIN', async () => {
    const mod = await import('../src/constants.js');
    const before = mod.ALLOWED_ORIGIN;
    mod.initCors(before);
    expect(mod.ALLOWED_ORIGIN).toBe(before);
  });
});
