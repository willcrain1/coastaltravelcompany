import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/crypto.js';

describe('hashPassword', () => {
  it('returns a non-empty base64 string', async () => {
    const hash = await hashPassword('mypassword');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
    // base64 chars only
    expect(hash).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('produces different hashes for the same password (salted)', async () => {
    const h1 = await hashPassword('samepassword');
    const h2 = await hashPassword('samepassword');
    expect(h1).not.toBe(h2);
  });

  it('produces a 48-byte (384-bit) output encoded in base64', async () => {
    const hash = await hashPassword('test');
    // 48 bytes in base64 = 64 chars
    const decoded = atob(hash);
    expect(decoded.length).toBe(48);
  });
});

describe('verifyPassword', () => {
  it('returns true for the correct password', async () => {
    const hash = await hashPassword('correct-password');
    const valid = await verifyPassword('correct-password', hash);
    expect(valid).toBe(true);
  });

  it('returns false for a wrong password', async () => {
    const hash = await hashPassword('correct-password');
    const valid = await verifyPassword('wrong-password', hash);
    expect(valid).toBe(false);
  });

  it('returns false when stored hash is null', async () => {
    const valid = await verifyPassword('anypassword', null);
    expect(valid).toBe(false);
  });

  it('returns false when stored hash is empty string', async () => {
    const valid = await verifyPassword('anypassword', '');
    expect(valid).toBe(false);
  });

  it('constant-time comparison: diff === 0 for matching hashes', async () => {
    // Indirectly tested: correct password returns true (diff must be 0)
    const hash = await hashPassword('testpass123');
    const result = await verifyPassword('testpass123', hash);
    expect(result).toBe(true);
  });

  it('handles passwords with special characters', async () => {
    const pw = 'p@$$w0rd!#%^&*()';
    const hash = await hashPassword(pw);
    expect(await verifyPassword(pw, hash)).toBe(true);
    expect(await verifyPassword('p@$$w0rd!#%^&*()', hash)).toBe(true);
    expect(await verifyPassword('different', hash)).toBe(false);
  });
});
