import { describe, it, expect, afterEach } from 'vitest';
import {
  NAS_SHARE_API, NAS_SHARE_PAGE, RATE_LIMIT, CONTACT_RATE_LIMIT,
  CONTACT_TO, WM_TEXT, JWT_EXPIRY_SECS, ALLOWED_APIS,
  initCors,
} from '../src/constants.js';

describe('constants', () => {
  it('NAS_SHARE_API points to the internal tunnel hostname', () => {
    expect(NAS_SHARE_API).toContain('nas.coastaltravelcompany.com');
  });
  it('NAS_SHARE_PAGE points to the internal tunnel hostname', () => {
    expect(NAS_SHARE_PAGE).toContain('nas.coastaltravelcompany.com');
  });
  it('ALLOWED_APIS contains only the four whitelisted Synology methods', () => {
    expect(ALLOWED_APIS.has('SYNO.Foto.Browse.Item')).toBe(true);
    expect(ALLOWED_APIS.has('SYNO.Foto.Thumbnail')).toBe(true);
    expect(ALLOWED_APIS.has('SYNO.Foto.Download')).toBe(true);
    expect(ALLOWED_APIS.has('SYNO.Foto.Streaming')).toBe(true);
    expect(ALLOWED_APIS.has('SYNO.Foto.Delete')).toBe(false);
  });
  it('RATE_LIMIT is 300', () => { expect(RATE_LIMIT).toBe(300); });
  it('CONTACT_RATE_LIMIT is 5', () => { expect(CONTACT_RATE_LIMIT).toBe(5); });
  it('JWT_EXPIRY_SECS is 7 days', () => { expect(JWT_EXPIRY_SECS).toBe(7 * 24 * 3600); });
  it('CONTACT_TO is a non-empty string', () => { expect(CONTACT_TO).toBeTruthy(); });
  it('WM_TEXT is a non-empty string', () => { expect(WM_TEXT).toBeTruthy(); });
});

describe('initCors', () => {
  const ORIGINAL = 'https://coastaltravelcompany.com';

  afterEach(async () => {
    const mod = await import('../src/constants.js');
    mod.initCors(ORIGINAL);
  });

  it('updates ALLOWED_ORIGIN and CORS header when given a different origin', async () => {
    const mod = await import('../src/constants.js');
    mod.initCors('https://preprod.coastaltravelcompany.com');
    expect(mod.ALLOWED_ORIGIN).toBe('https://preprod.coastaltravelcompany.com');
    expect(mod.CORS['Access-Control-Allow-Origin']).toBe('https://preprod.coastaltravelcompany.com');
  });

  it('is a no-op when given the same origin as current', async () => {
    const mod = await import('../src/constants.js');
    const before = mod.ALLOWED_ORIGIN;
    mod.initCors(before);
    expect(mod.ALLOWED_ORIGIN).toBe(before);
  });

  it('is a no-op when given falsy values', async () => {
    const mod = await import('../src/constants.js');
    const before = mod.ALLOWED_ORIGIN;
    mod.initCors(null);
    mod.initCors(undefined);
    mod.initCors('');
    expect(mod.ALLOWED_ORIGIN).toBe(before);
  });
});
