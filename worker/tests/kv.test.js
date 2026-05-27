import { describe, it, expect, beforeEach } from 'vitest';
import {
  getUser, putUser, deleteUser, listUsers, getUserById,
  getGallery, putGallery, deleteGallery, listGalleries,
  syncGalleryAssignments, stripSensitive, stripGallery,
} from '../src/kv.js';

function makeKv() {
  const store = new Map();
  return {
    _store: store,
    get:    (k)          => Promise.resolve(store.has(k) ? store.get(k) : null),
    put:    (k, v, _opts) => { store.set(k, v); return Promise.resolve(); },
    delete: (k)          => { store.delete(k); return Promise.resolve(); },
  };
}

function makeUser(overrides = {}) {
  return {
    id: 'user-id-1',
    email: 'test@example.com',
    passwordHash: 'hashed-password',
    role: 'client',
    created: Date.now(),
    galleries: [],
    ...overrides,
  };
}

function makeGallery(overrides = {}) {
  return {
    id: 'gallery-1',
    eventName: 'Test Event',
    passphrase: 'secret-passphrase',
    assignedUsers: [],
    ...overrides,
  };
}

describe('User KV helpers', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('putUser + getUser round-trips by email', async () => {
    const user = makeUser();
    await putUser(user, kv);
    const found = await getUser('test@example.com', kv);
    expect(found).not.toBeNull();
    expect(found.email).toBe('test@example.com');
    expect(found.id).toBe('user-id-1');
  });

  it('getUser returns null when not found', async () => {
    const found = await getUser('nobody@example.com', kv);
    expect(found).toBeNull();
  });

  it('putUser normalizes email to lowercase', async () => {
    const user = makeUser({ email: 'Upper@Example.COM' });
    await putUser(user, kv);
    const found = await getUser('upper@example.com', kv);
    expect(found).not.toBeNull();
  });

  it('putUser adds to users_list', async () => {
    await putUser(makeUser(), kv);
    const raw  = await kv.get('users_list');
    const list = JSON.parse(raw);
    expect(list).toContain('test@example.com');
  });

  it('putUser does not duplicate entries in users_list', async () => {
    await putUser(makeUser(), kv);
    await putUser(makeUser({ role: 'admin' }), kv);
    const raw  = await kv.get('users_list');
    const list = JSON.parse(raw);
    const count = list.filter(e => e === 'test@example.com').length;
    expect(count).toBe(1);
  });

  it('putUser creates user_id: index', async () => {
    const user = makeUser();
    await putUser(user, kv);
    const email = await kv.get('user_id:user-id-1');
    expect(email).toBe('test@example.com');
  });

  it('getUserById resolves via user_id index', async () => {
    await putUser(makeUser(), kv);
    const found = await getUserById('user-id-1', kv);
    expect(found).not.toBeNull();
    expect(found.email).toBe('test@example.com');
  });

  it('getUserById returns null for unknown id', async () => {
    const found = await getUserById('no-such-id', kv);
    expect(found).toBeNull();
  });

  it('deleteUser removes user and updates list', async () => {
    await putUser(makeUser(), kv);
    await deleteUser('test@example.com', kv);
    const found = await getUser('test@example.com', kv);
    expect(found).toBeNull();
    const raw  = await kv.get('users_list');
    const list = JSON.parse(raw);
    expect(list).not.toContain('test@example.com');
  });

  it('deleteUser is a no-op for unknown email', async () => {
    await expect(deleteUser('nobody@example.com', kv)).resolves.toBeUndefined();
  });

  it('listUsers returns all stored users', async () => {
    await putUser(makeUser({ id: 'u1', email: 'a@test.com' }), kv);
    await putUser(makeUser({ id: 'u2', email: 'b@test.com' }), kv);
    const users = await listUsers(kv);
    expect(users).toHaveLength(2);
    const emails = users.map(u => u.email);
    expect(emails).toContain('a@test.com');
    expect(emails).toContain('b@test.com');
  });

  it('listUsers returns empty array when no users', async () => {
    const users = await listUsers(kv);
    expect(users).toEqual([]);
  });
});

describe('Gallery KV helpers', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('putGallery + getGallery round-trips', async () => {
    const gallery = makeGallery();
    await putGallery(gallery, kv);
    const found = await getGallery('gallery-1', kv);
    expect(found).not.toBeNull();
    expect(found.id).toBe('gallery-1');
    expect(found.passphrase).toBe('secret-passphrase');
  });

  it('getGallery returns null for unknown id', async () => {
    const found = await getGallery('no-such-id', kv);
    expect(found).toBeNull();
  });

  it('putGallery prepends to galleries_list', async () => {
    await putGallery(makeGallery({ id: 'g1' }), kv);
    await putGallery(makeGallery({ id: 'g2' }), kv);
    const raw  = await kv.get('galleries_list');
    const list = JSON.parse(raw);
    // g2 prepended last so is at index 0
    expect(list[0]).toBe('g2');
    expect(list).toContain('g1');
  });

  it('putGallery does not duplicate in galleries_list', async () => {
    await putGallery(makeGallery(), kv);
    await putGallery(makeGallery({ eventName: 'Updated' }), kv);
    const raw  = await kv.get('galleries_list');
    const list = JSON.parse(raw);
    const count = list.filter(id => id === 'gallery-1').length;
    expect(count).toBe(1);
  });

  it('deleteGallery removes gallery and updates list', async () => {
    await putGallery(makeGallery(), kv);
    await deleteGallery('gallery-1', kv);
    const found = await getGallery('gallery-1', kv);
    expect(found).toBeNull();
    const raw  = await kv.get('galleries_list');
    const list = JSON.parse(raw);
    expect(list).not.toContain('gallery-1');
  });

  it('listGalleries returns all galleries', async () => {
    await putGallery(makeGallery({ id: 'g1' }), kv);
    await putGallery(makeGallery({ id: 'g2' }), kv);
    const galleries = await listGalleries(kv);
    expect(galleries).toHaveLength(2);
  });

  it('listGalleries returns empty array when none stored', async () => {
    const galleries = await listGalleries(kv);
    expect(galleries).toEqual([]);
  });
});

describe('syncGalleryAssignments', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('adds user to gallery assignedUsers when in added list', async () => {
    await putGallery(makeGallery({ id: 'g1', assignedUsers: [] }), kv);
    await syncGalleryAssignments('user@test.com', ['g1'], [], kv);
    const g = await getGallery('g1', kv);
    expect(g.assignedUsers).toContain('user@test.com');
  });

  it('does not duplicate in assignedUsers', async () => {
    await putGallery(makeGallery({ id: 'g1', assignedUsers: ['user@test.com'] }), kv);
    await syncGalleryAssignments('user@test.com', ['g1'], [], kv);
    const g = await getGallery('g1', kv);
    const count = g.assignedUsers.filter(e => e === 'user@test.com').length;
    expect(count).toBe(1);
  });

  it('removes user from gallery assignedUsers when in removed list', async () => {
    await putGallery(makeGallery({ id: 'g1', assignedUsers: ['user@test.com'] }), kv);
    await syncGalleryAssignments('user@test.com', [], ['g1'], kv);
    const g = await getGallery('g1', kv);
    expect(g.assignedUsers).not.toContain('user@test.com');
  });

  it('handles missing gallery gracefully in added list', async () => {
    await expect(syncGalleryAssignments('user@test.com', ['nonexistent'], [], kv))
      .resolves.toBeUndefined();
  });
});

describe('stripSensitive', () => {
  it('removes passwordHash from user object', () => {
    const user = {
      id: 'u1', email: 'a@b.com', role: 'admin',
      created: 1234, galleries: ['g1'],
      passwordHash: 'secret-hash',
      verified: true,
    };
    const stripped = stripSensitive(user);
    expect(stripped.passwordHash).toBeUndefined();
    expect(stripped.id).toBe('u1');
    expect(stripped.email).toBe('a@b.com');
    expect(stripped.role).toBe('admin');
  });

  it('sets hasPassword to true when passwordHash is present', () => {
    const user = { id: 'u1', email: 'a@b.com', role: 'client', created: 1, galleries: [], passwordHash: 'hash' };
    expect(stripSensitive(user).hasPassword).toBe(true);
  });

  it('sets hasPassword to false when passwordHash is null', () => {
    const user = { id: 'u1', email: 'a@b.com', role: 'client', created: 1, galleries: [], passwordHash: null };
    expect(stripSensitive(user).hasPassword).toBe(false);
  });

  it('defaults verified to true when not set to false', () => {
    const user = { id: 'u1', email: 'a@b.com', role: 'client', created: 1, galleries: [] };
    expect(stripSensitive(user).verified).toBe(true);
  });

  it('preserves verified: false', () => {
    const user = { id: 'u1', email: 'a@b.com', role: 'client', created: 1, galleries: [], verified: false };
    expect(stripSensitive(user).verified).toBe(false);
  });
});

describe('stripGallery', () => {
  it('removes passphrase field', () => {
    const g = { id: 'g1', eventName: 'Test', passphrase: 'secret', assignedUsers: [] };
    const stripped = stripGallery(g);
    expect(stripped.passphrase).toBeUndefined();
    expect(stripped.id).toBe('g1');
  });

  it('removes pw, pwHash, sharePassword fields', () => {
    const g = { id: 'g1', pw: 'pw', pwHash: 'hash', sharePassword: 'sp', passphrase: 'pp' };
    const stripped = stripGallery(g);
    expect(stripped.pw).toBeUndefined();
    expect(stripped.pwHash).toBeUndefined();
    expect(stripped.sharePassword).toBeUndefined();
    expect(stripped.passphrase).toBeUndefined();
  });

  it('returns null when gallery is null', () => {
    expect(stripGallery(null)).toBeNull();
  });

  it('preserves non-sensitive fields', () => {
    const g = { id: 'g1', eventName: 'Beach', passphrase: 'secret', assignedUsers: ['u@u.com'] };
    const stripped = stripGallery(g);
    expect(stripped.eventName).toBe('Beach');
    expect(stripped.assignedUsers).toEqual(['u@u.com']);
  });
});
