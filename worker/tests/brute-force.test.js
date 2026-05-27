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
    get:    async (k)       => store.get(k) ?? null,
    put:    async (k, v, _) => { store.set(k, v); },
    delete: async (k)       => { store.delete(k); },
    _store: store,
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

// ── Login brute-force ─────────────────────────────────────────────────────────

describe('checkLoginBruteForce', () => {
  it('returns locked:false when no failures recorded', async () => {
    const kv = makeKv();
    const r  = await checkLoginBruteForce('user@t.com', '1.1.1.1', kv);
    expect(r.locked).toBe(false);
  });

  it('returns locked:true when permanent lock key exists', async () => {
    const kv = makeKv();
    await kv.put('locked:admin@t.com', '1');
    const r = await checkLoginBruteForce('admin@t.com', '1.1.1.1', kv);
    expect(r.locked).toBe(true);
    expect(r.reason).toMatch(/reset your password/i);
  });

  it('returns locked:true after 5 email failures', async () => {
    const kv = makeKv();
    await kv.put('brute:email:user@t.com', '5');
    const r = await checkLoginBruteForce('user@t.com', '1.1.1.1', kv);
    expect(r.locked).toBe(true);
    expect(r.reason).toMatch(/15 minutes/i);
  });

  it('not locked at 4 email failures', async () => {
    const kv = makeKv();
    await kv.put('brute:email:user@t.com', '4');
    expect((await checkLoginBruteForce('user@t.com', '1.1.1.1', kv)).locked).toBe(false);
  });

  it('returns locked:true after 20 IP failures', async () => {
    const kv = makeKv();
    await kv.put('brute:ip:10.0.0.1', '20');
    const r = await checkLoginBruteForce('user@t.com', '10.0.0.1', kv);
    expect(r.locked).toBe(true);
    expect(r.reason).toMatch(/network/i);
  });

  it('not locked at 19 IP failures', async () => {
    const kv = makeKv();
    await kv.put('brute:ip:10.0.0.1', '19');
    expect((await checkLoginBruteForce('user@t.com', '10.0.0.1', kv)).locked).toBe(false);
  });
});

describe('recordLoginFailure', () => {
  it('increments email and IP counters', async () => {
    const kv = makeKv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await recordLoginFailure('user@t.com', '1.2.3.4', 'client', kv, null);
    expect(await kv.get('brute:email:user@t.com')).toBe('1');
    expect(await kv.get('brute:ip:1.2.3.4')).toBe('1');
  });

  it('sets permanent lock at 5th admin failure', async () => {
    const kv = makeKv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await kv.put('brute:email:admin@t.com', '4');
    await recordLoginFailure('admin@t.com', '1.2.3.4', 'admin', kv, null);
    expect(await kv.get('locked:admin@t.com')).toBe('1');
  });

  it('does not set permanent lock for client role', async () => {
    const kv = makeKv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await kv.put('brute:email:client@t.com', '4');
    await recordLoginFailure('client@t.com', '1.2.3.4', 'client', kv, null);
    expect(await kv.get('locked:client@t.com')).toBeNull();
  });

  it('sends alert at 3rd admin failure when API key present', async () => {
    const kv       = makeKv();
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    await kv.put('brute:email:admin@t.com', '2');
    await recordLoginFailure('admin@t.com', '1.2.3.4', 'admin', kv, 'resend-key');
    // Fire-and-forget — allow microtasks to settle
    await new Promise(r => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not send alert when resendApiKey is null', async () => {
    const kv       = makeKv();
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    await kv.put('brute:email:admin@t.com', '2');
    await recordLoginFailure('admin@t.com', '1.2.3.4', 'admin', kv, null);
    await new Promise(r => setTimeout(r, 0));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('clearLoginCounters', () => {
  it('deletes email and IP keys', async () => {
    const kv = makeKv();
    await kv.put('brute:email:user@t.com', '3');
    await kv.put('brute:ip:5.5.5.5', '5');
    await clearLoginCounters('user@t.com', '5.5.5.5', kv);
    expect(await kv.get('brute:email:user@t.com')).toBeNull();
    expect(await kv.get('brute:ip:5.5.5.5')).toBeNull();
  });
});

// ── Password reset brute-force ────────────────────────────────────────────────

describe('checkResetBruteForce', () => {
  it('returns locked:false initially', async () => {
    const kv = makeKv();
    expect((await checkResetBruteForce('u@t.com', '1.1.1.1', kv)).locked).toBe(false);
  });

  it('locked after 3 email reset requests', async () => {
    const kv = makeKv();
    await kv.put('brute:reset:u@t.com', '3');
    expect((await checkResetBruteForce('u@t.com', '1.1.1.1', kv)).locked).toBe(true);
  });

  it('not locked at 2 email reset requests', async () => {
    const kv = makeKv();
    await kv.put('brute:reset:u@t.com', '2');
    expect((await checkResetBruteForce('u@t.com', '1.1.1.1', kv)).locked).toBe(false);
  });

  it('locked after 10 IP reset requests', async () => {
    const kv = makeKv();
    await kv.put('brute:reset:ip:9.9.9.9', '10');
    expect((await checkResetBruteForce('u@t.com', '9.9.9.9', kv)).locked).toBe(true);
  });

  it('not locked at 9 IP reset requests', async () => {
    const kv = makeKv();
    await kv.put('brute:reset:ip:9.9.9.9', '9');
    expect((await checkResetBruteForce('u@t.com', '9.9.9.9', kv)).locked).toBe(false);
  });
});

describe('recordResetAttempt', () => {
  it('increments both email and IP counters', async () => {
    const kv = makeKv();
    await recordResetAttempt('u@t.com', '2.2.2.2', kv);
    expect(await kv.get('brute:reset:u@t.com')).toBe('1');
    expect(await kv.get('brute:reset:ip:2.2.2.2')).toBe('1');
  });
});

// ── Gallery unlock brute-force ────────────────────────────────────────────────

describe('checkGalleryUnlockBruteForce', () => {
  it('returns false when no failures', async () => {
    const kv = makeKv();
    expect(await checkGalleryUnlockBruteForce('3.3.3.3', kv)).toBe(false);
  });

  it('returns false at 9 failures', async () => {
    const kv = makeKv();
    await kv.put('brute:gallery:ip:3.3.3.3', '9');
    expect(await checkGalleryUnlockBruteForce('3.3.3.3', kv)).toBe(false);
  });

  it('returns true at 10 failures', async () => {
    const kv = makeKv();
    await kv.put('brute:gallery:ip:3.3.3.3', '10');
    expect(await checkGalleryUnlockBruteForce('3.3.3.3', kv)).toBe(true);
  });
});

describe('recordGalleryUnlockFailure', () => {
  it('increments the IP counter', async () => {
    const kv = makeKv();
    await recordGalleryUnlockFailure('4.4.4.4', kv);
    expect(await kv.get('brute:gallery:ip:4.4.4.4')).toBe('1');
  });
});

describe('clearGalleryUnlockCounter', () => {
  it('deletes the IP counter key', async () => {
    const kv = makeKv();
    await kv.put('brute:gallery:ip:5.5.5.5', '7');
    await clearGalleryUnlockCounter('5.5.5.5', kv);
    expect(await kv.get('brute:gallery:ip:5.5.5.5')).toBeNull();
  });
});
