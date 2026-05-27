import { describe, it, expect, beforeEach } from 'vitest';
import {
  getUser, getUserById, putUser, deleteUser, listUsers,
  getGallery, putGallery, deleteGallery, listGalleries,
  syncGalleryAssignments, stripSensitive, stripGallery,
} from '../src/kv.js';

function makeKv() {
  const store = new Map();
  return {
    get:    async (k)    => store.get(k) ?? null,
    put:    async (k, v) => { store.set(k, v); },
    delete: async (k)    => { store.delete(k); },
  };
}

const user1 = () => ({ id: 'u1', email: 'Alice@Example.com', role: 'admin', created: 1, galleries: [] });
const gal1  = () => ({ id: 'g1', eventName: 'Wedding', passphrase: 'secret' });

describe('getUser / putUser', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('returns null for a nonexistent user', async () => {
    expect(await getUser('nobody@example.com', kv)).toBeNull();
  });
  it('stores and retrieves by lowercase email', async () => {
    await putUser(user1(), kv);
    expect((await getUser('alice@example.com', kv))?.id).toBe('u1');
  });
  it('does not duplicate entries in the users_list', async () => {
    await putUser(user1(), kv);
    await putUser(user1(), kv);
    const list = await listUsers(kv);
    expect(list.filter(u => u.id === 'u1').length).toBe(1);
  });
});

describe('getUserById', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('resolves a user by id', async () => {
    await putUser(user1(), kv);
    expect((await getUserById('u1', kv))?.email).toBe('Alice@Example.com');
  });
  it('returns null for unknown id', async () => {
    expect(await getUserById('nope', kv)).toBeNull();
  });
});

describe('deleteUser', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('removes user from store and list', async () => {
    await putUser(user1(), kv);
    await deleteUser('alice@example.com', kv);
    expect(await getUser('alice@example.com', kv)).toBeNull();
    expect((await listUsers(kv)).find(u => u.id === 'u1')).toBeUndefined();
  });
  it('is a no-op for a nonexistent user', async () => {
    await expect(deleteUser('ghost@example.com', kv)).resolves.toBeUndefined();
  });
});

describe('listUsers', () => {
  it('returns all stored users', async () => {
    const kv = makeKv();
    await putUser({ id: 'a', email: 'a@t.com', role: 'admin', created: 1, galleries: [] }, kv);
    await putUser({ id: 'b', email: 'b@t.com', role: 'client', created: 2, galleries: [] }, kv);
    expect((await listUsers(kv)).length).toBe(2);
  });
  it('returns empty array when no users', async () => {
    expect(await listUsers(makeKv())).toEqual([]);
  });
});

describe('getGallery / putGallery', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('returns null for nonexistent gallery', async () => {
    expect(await getGallery('nope', kv)).toBeNull();
  });
  it('stores and retrieves a gallery', async () => {
    await putGallery(gal1(), kv);
    expect((await getGallery('g1', kv))?.eventName).toBe('Wedding');
  });
  it('prepends newer galleries to the list (most recent first)', async () => {
    await putGallery({ id: 'ga' }, kv);
    await putGallery({ id: 'gb' }, kv);
    const list = await listGalleries(kv);
    expect(list[0].id).toBe('gb');
  });
  it('does not duplicate in list', async () => {
    await putGallery(gal1(), kv);
    await putGallery(gal1(), kv);
    expect((await listGalleries(kv)).filter(g => g.id === 'g1').length).toBe(1);
  });
});

describe('deleteGallery', () => {
  it('removes gallery and updates list', async () => {
    const kv = makeKv();
    await putGallery(gal1(), kv);
    await deleteGallery('g1', kv);
    expect(await getGallery('g1', kv)).toBeNull();
    expect((await listGalleries(kv)).find(g => g.id === 'g1')).toBeUndefined();
  });
});

describe('listGalleries', () => {
  it('returns empty array when none stored', async () => {
    expect(await listGalleries(makeKv())).toEqual([]);
  });
});

describe('syncGalleryAssignments', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('adds user email to assignedUsers', async () => {
    await putGallery({ id: 'g1', assignedUsers: [] }, kv);
    await syncGalleryAssignments('u@t.com', ['g1'], [], kv);
    expect((await getGallery('g1', kv)).assignedUsers).toContain('u@t.com');
  });
  it('does not add duplicate assignment', async () => {
    await putGallery({ id: 'g1', assignedUsers: ['u@t.com'] }, kv);
    await syncGalleryAssignments('u@t.com', ['g1'], [], kv);
    const g = await getGallery('g1', kv);
    expect(g.assignedUsers.filter(e => e === 'u@t.com').length).toBe(1);
  });
  it('removes user email from assignedUsers', async () => {
    await putGallery({ id: 'g1', assignedUsers: ['u@t.com'] }, kv);
    await syncGalleryAssignments('u@t.com', [], ['g1'], kv);
    expect((await getGallery('g1', kv)).assignedUsers).not.toContain('u@t.com');
  });
  it('handles gallery with no assignedUsers field', async () => {
    await putGallery({ id: 'g1' }, kv);
    await syncGalleryAssignments('u@t.com', ['g1'], [], kv);
    expect((await getGallery('g1', kv)).assignedUsers).toContain('u@t.com');
  });
  it('silently skips nonexistent gallery ids', async () => {
    await expect(syncGalleryAssignments('u@t.com', ['nope'], [], kv)).resolves.toBeUndefined();
    await expect(syncGalleryAssignments('u@t.com', [], ['nope'], kv)).resolves.toBeUndefined();
  });
  it('removes from gallery with no assignedUsers field (defaults to empty array)', async () => {
    await putGallery({ id: 'g1' }, kv);
    await syncGalleryAssignments('u@t.com', [], ['g1'], kv);
    expect((await getGallery('g1', kv)).assignedUsers).toEqual([]);
  });
});

describe('stripSensitive', () => {
  it('omits passwordHash and exposes hasPassword flag', () => {
    const u = { id: 'u1', email: 'a@b.com', role: 'client', created: 1, galleries: ['g1'], passwordHash: 'hash', verified: true };
    const s = stripSensitive(u);
    expect(s.passwordHash).toBeUndefined();
    expect(s.hasPassword).toBe(true);
    expect(s.galleries).toEqual(['g1']);
    expect(s.verified).toBe(true);
  });
  it('defaults galleries to [] when absent', () => {
    expect(stripSensitive({ id: 'u1', email: 'a@b.com', role: 'client', created: 1 }).galleries).toEqual([]);
  });
  it('verified defaults to true when undefined', () => {
    expect(stripSensitive({ id: 'u1', email: 'a@b.com', role: 'client', created: 1 }).verified).toBe(true);
  });
  it('hasPassword is false when no passwordHash', () => {
    expect(stripSensitive({ id: 'u1', email: 'a@b.com', role: 'client', created: 1 }).hasPassword).toBe(false);
  });
});

describe('stripGallery', () => {
  it('removes sensitive fields', () => {
    const g = { id: 'g1', eventName: 'E', passphrase: 's', pw: 'p', pwHash: 'h', sharePassword: 'sp' };
    const s = stripGallery(g);
    expect(s.passphrase).toBeUndefined();
    expect(s.pw).toBeUndefined();
    expect(s.pwHash).toBeUndefined();
    expect(s.sharePassword).toBeUndefined();
    expect(s.eventName).toBe('E');
  });
  it('returns null for null input', () => { expect(stripGallery(null)).toBeNull(); });
  it('returns null for undefined input', () => { expect(stripGallery(undefined)).toBeNull(); });
});
