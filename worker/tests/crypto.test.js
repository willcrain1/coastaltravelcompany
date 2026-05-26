import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/crypto.js';

describe('hashPassword', () => {
  it('returns a base64 string', async () => {
    const h = await hashPassword('MyPassword123!');
    expect(typeof h).toBe('string');
    expect(h).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
  it('produces different hashes for the same password (random salt)', async () => {
    const h1 = await hashPassword('same');
    const h2 = await hashPassword('same');
    expect(h1).not.toBe(h2);
  });
  it('output decodes to exactly 48 bytes (16 salt + 32 hash)', async () => {
    const h = await hashPassword('test');
    expect(atob(h).length).toBe(48);
  });
});

describe('verifyPassword', () => {
  it('returns true for the correct password', async () => {
    const h = await hashPassword('Correct!');
    expect(await verifyPassword('Correct!', h)).toBe(true);
  });
  it('returns false for a wrong password', async () => {
    const h = await hashPassword('Correct!');
    expect(await verifyPassword('Wrong!', h)).toBe(false);
  });
  it('returns false when stored hash is null', async () => {
    expect(await verifyPassword('anything', null)).toBe(false);
  });
  it('returns false when stored hash is empty string', async () => {
    expect(await verifyPassword('anything', '')).toBe(false);
  });
  it('returns false when stored hash is undefined', async () => {
    expect(await verifyPassword('anything', undefined)).toBe(false);
  });
  it('is case-sensitive', async () => {
    const h = await hashPassword('password');
    expect(await verifyPassword('Password', h)).toBe(false);
  });
});
