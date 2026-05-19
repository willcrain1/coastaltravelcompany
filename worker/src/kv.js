// KV helpers — users and galleries
// All functions accept the kv binding as an explicit argument (no env dependency).

export async function getUser(email, kv) {
  const raw = await kv.get('user:' + email.toLowerCase());
  return raw ? JSON.parse(raw) : null;
}

export async function getUserById(id, kv) {
  const email = await kv.get('user_id:' + id);
  return email ? getUser(email, kv) : null;
}

export async function putUser(user, kv) {
  const email = user.email.toLowerCase();
  await kv.put('user:' + email, JSON.stringify(user));
  await kv.put('user_id:' + user.id, email);
  const raw  = await kv.get('users_list');
  const list = raw ? JSON.parse(raw) : [];
  if (!list.includes(email)) {
    list.push(email);
    await kv.put('users_list', JSON.stringify(list));
  }
}

export async function deleteUser(email, kv) {
  email = email.toLowerCase();
  const user = await getUser(email, kv);
  if (!user) return;
  await kv.delete('user:' + email);
  await kv.delete('user_id:' + user.id);
  const raw  = await kv.get('users_list');
  const list = raw ? JSON.parse(raw).filter(e => e !== email) : [];
  await kv.put('users_list', JSON.stringify(list));
}

export async function listUsers(kv) {
  const raw    = await kv.get('users_list');
  const emails = raw ? JSON.parse(raw) : [];
  const users  = await Promise.all(emails.map(e => getUser(e, kv)));
  return users.filter(Boolean);
}

export async function getGallery(id, kv) {
  const raw = await kv.get('gallery:' + id);
  return raw ? JSON.parse(raw) : null;
}

export async function putGallery(gallery, kv) {
  await kv.put('gallery:' + gallery.id, JSON.stringify(gallery));
  const raw  = await kv.get('galleries_list');
  const list = raw ? JSON.parse(raw) : [];
  if (!list.includes(gallery.id)) {
    list.unshift(gallery.id);
    await kv.put('galleries_list', JSON.stringify(list));
  }
}

export async function deleteGallery(id, kv) {
  await kv.delete('gallery:' + id);
  const raw  = await kv.get('galleries_list');
  const list = raw ? JSON.parse(raw).filter(g => g !== id) : [];
  await kv.put('galleries_list', JSON.stringify(list));
}

export async function listGalleries(kv) {
  const raw = await kv.get('galleries_list');
  const ids = raw ? JSON.parse(raw) : [];
  const gs  = await Promise.all(ids.map(id => getGallery(id, kv)));
  return gs.filter(Boolean);
}

export async function syncGalleryAssignments(userEmail, added, removed, kv) {
  for (const id of added) {
    const g = await getGallery(id, kv);
    if (g && !(g.assignedUsers || []).includes(userEmail)) {
      g.assignedUsers = [...(g.assignedUsers || []), userEmail];
      await putGallery(g, kv);
    }
  }
  for (const id of removed) {
    const g = await getGallery(id, kv);
    if (g) {
      g.assignedUsers = (g.assignedUsers || []).filter(e => e !== userEmail);
      await putGallery(g, kv);
    }
  }
}

export function stripSensitive(u) {
  return {
    id: u.id, email: u.email, role: u.role, created: u.created,
    galleries: u.galleries || [],
    verified: u.verified !== false,
    hasPassword: !!u.passwordHash,
  };
}

export function stripGallery(g) {
  if (!g) return null;
  const { passphrase, pw, pwHash, sharePassword, ...safe } = g;
  return safe;
}
