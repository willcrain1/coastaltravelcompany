import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  checkLoginBruteForce,
  recordLoginFailure,
  clearLoginCounters,
  checkResetBruteForce,
  recordResetAttempt,
  checkGalleryUnlockBruteForce,
  recordGalleryUnlockFailure,
  clearGalleryUnlockCounter,
} from '../src/brute-force.js';

function makeKv() {
  const store = new Map();
  return {
    _store: store,
    get:    (k)           => Promise.resolve(store.has(k) ? store.get(k) : null),
    put:    (k, v, _opts) => { store.set(k, v); return Promise.resolve(); },
    delete: (k)           => { store.delete(k); return Promise.resolve(); },
  };
}

describe('checkLoginBruteForce', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('returns locked: false when no failures have been recorded', async () => {
    const result = await checkLoginBruteForce('user@test.com', '1.2.3.4', kv);
    expect(result.locked).toBe(false);
  });

  it('returns locked: true after 5 email failures', async () => {
    kv._store.set('brute:email:user@test.com', '5');
    const result = await checkLoginBruteForce('user@test.com', '1.2.3.4', kv);
    expect(result.locked).toBe(true);
    expect(result.reason).toMatch(/try again in 15 minutes/i);
  });

  it('is not locked at 4 email failures', async () => {
    kv._store.set('brute:email:user@test.com', '4');
    const result = await checkLoginBruteForce('user@test.com', '1.2.3.4', kv);
    expect(result.locked).toBe(false);
  });

  it('returns locked: true after 20 IP failures', async () => {
    kv._store.set('brute:ip:10.0.0.1', '20');
    const result = await checkLoginBruteForce('user@test.com', '10.0.0.1', kv);
    expect(result.locked).toBe(true);
    expect(result.reason).toMatch(/too many requests from your network/i);
  });

  it('is not locked at 19 IP failures', async () => {
    kv._store.set('brute:ip:10.0.0.1', '19');
    const result = await checkLoginBruteForce('user@test.com', '10.0.0.1', kv);
    expect(result.locked).toBe(false);
  });

  it('returns locked: true when permanent lock key exists', async () => {
    kv._store.set('locked:admin@test.com', '1');
    const result = await checkLoginBruteForce('admin@test.com', '1.2.3.4', kv);
    expect(result.locked).toBe(true);
    expect(result.reason).toMatch(/reset your password/i);
  });
});

describe('recordLoginFailure', () => {
  let kv;
  beforeEach(() => {
    kv = makeKv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('increments email counter', async () => {
    await recordLoginFailure('user@test.com', '1.2.3.4', 'client', kv, null);
    const count = kv._store.get('brute:email:user@test.com');
    expect(count).toBe('1');
  });

  it('increments IP counter', async () => {
    await recordLoginFailure('user@test.com', '1.2.3.4', 'client', kv, null);
    const count = kv._store.get('brute:ip:1.2.3.4');
    expect(count).toBe('1');
  });

  it('sets permanent lock at 5 failures for admin', async () => {
    kv._store.set('brute:email:admin@test.com', '4');
    await recordLoginFailure('admin@test.com', '1.2.3.4', 'admin', kv, null);
    expect(kv._store.has('locked:admin@test.com')).toBe(true);
  });

  it('does NOT set permanent lock at 4 failures for admin', async () => {
    kv._store.set('brute:email:admin@test.com', '3');
    await recordLoginFailure('admin@test.com', '1.2.3.4', 'admin', kv, null);
    expect(kv._store.has('locked:admin@test.com')).toBe(false);
  });

  it('does not set permanent lock for client role even at high count', async () => {
    kv._store.set('brute:email:client@test.com', '4');
    await recordLoginFailure('client@test.com', '1.2.3.4', 'client', kv, null);
    expect(kv._store.has('locked:client@test.com')).toBe(false);
  });

  it('sends Resend alert at 3 failures for admin when API key is present', async () => {
    kv._store.set('brute:email:admin@test.com', '2');
    await recordLoginFailure('admin@test.com', '1.2.3.4', 'admin', kv, 'resend-api-key');
    // Allow the fire-and-forget fetch to complete
    await new Promise(r => setTimeout(r, 0));
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('does not send alert for client role', async () => {
    kv._store.set('brute:email:client@test.com', '2');
    await recordLoginFailure('client@test.com', '1.2.3.4', 'client', kv, 'resend-api-key');
    await new Promise(r => setTimeout(r, 0));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('does not send alert when resendApiKey is null', async () => {
    kv._store.set('brute:email:admin@test.com', '2');
    await recordLoginFailure('admin@test.com', '1.2.3.4', 'admin', kv, null);
    await new Promise(r => setTimeout(r, 0));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('clearLoginCounters', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('deletes email and IP counters', async () => {
    kv._store.set('brute:email:user@test.com', '3');
    kv._store.set('brute:ip:5.5.5.5', '3');
    await clearLoginCounters('user@test.com', '5.5.5.5', kv);
    expect(kv._store.has('brute:email:user@test.com')).toBe(false);
    expect(kv._store.has('brute:ip:5.5.5.5')).toBe(false);
  });
});

describe('checkResetBruteForce', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('returns locked: false when no attempts recorded', async () => {
    const result = await checkResetBruteForce('user@test.com', '1.2.3.4', kv);
    expect(result.locked).toBe(false);
  });

  it('returns locked: true after 3 email reset attempts', async () => {
    kv._store.set('brute:reset:user@test.com', '3');
    const result = await checkResetBruteForce('user@test.com', '1.2.3.4', kv);
    expect(result.locked).toBe(true);
  });

  it('is not locked at 2 email reset attempts', async () => {
    kv._store.set('brute:reset:user@test.com', '2');
    const result = await checkResetBruteForce('user@test.com', '1.2.3.4', kv);
    expect(result.locked).toBe(false);
  });

  it('returns locked: true after 10 IP reset attempts', async () => {
    kv._store.set('brute:reset:ip:9.9.9.9', '10');
    const result = await checkResetBruteForce('user@test.com', '9.9.9.9', kv);
    expect(result.locked).toBe(true);
  });

  it('is not locked at 9 IP reset attempts', async () => {
    kv._store.set('brute:reset:ip:9.9.9.9', '9');
    const result = await checkResetBruteForce('user@test.com', '9.9.9.9', kv);
    expect(result.locked).toBe(false);
  });
});

describe('recordResetAttempt', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('increments both email and IP counters', async () => {
    await recordResetAttempt('user@test.com', '1.2.3.4', kv);
    expect(kv._store.get('brute:reset:user@test.com')).toBe('1');
    expect(kv._store.get('brute:reset:ip:1.2.3.4')).toBe('1');
  });

  it('increments from existing value', async () => {
    kv._store.set('brute:reset:user@test.com', '2');
    await recordResetAttempt('user@test.com', '1.2.3.4', kv);
    expect(kv._store.get('brute:reset:user@test.com')).toBe('3');
  });
});

describe('checkGalleryUnlockBruteForce', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('returns false when no failures recorded', async () => {
    const locked = await checkGalleryUnlockBruteForce('1.2.3.4', kv);
    expect(locked).toBe(false);
  });

  it('returns false at 9 failures', async () => {
    kv._store.set('brute:gallery:ip:1.2.3.4', '9');
    const locked = await checkGalleryUnlockBruteForce('1.2.3.4', kv);
    expect(locked).toBe(false);
  });

  it('returns true at 10 failures', async () => {
    kv._store.set('brute:gallery:ip:1.2.3.4', '10');
    const locked = await checkGalleryUnlockBruteForce('1.2.3.4', kv);
    expect(locked).toBe(true);
  });

  it('returns true above 10 failures', async () => {
    kv._store.set('brute:gallery:ip:1.2.3.4', '15');
    const locked = await checkGalleryUnlockBruteForce('1.2.3.4', kv);
    expect(locked).toBe(true);
  });
});

describe('recordGalleryUnlockFailure', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('increments the gallery IP counter', async () => {
    await recordGalleryUnlockFailure('1.2.3.4', kv);
    expect(kv._store.get('brute:gallery:ip:1.2.3.4')).toBe('1');
  });

  it('increments from existing value', async () => {
    kv._store.set('brute:gallery:ip:1.2.3.4', '5');
    await recordGalleryUnlockFailure('1.2.3.4', kv);
    expect(kv._store.get('brute:gallery:ip:1.2.3.4')).toBe('6');
  });
});

describe('clearGalleryUnlockCounter', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('deletes the gallery IP counter key', async () => {
    kv._store.set('brute:gallery:ip:1.2.3.4', '7');
    await clearGalleryUnlockCounter('1.2.3.4', kv);
    expect(kv._store.has('brute:gallery:ip:1.2.3.4')).toBe(false);
  });
});
