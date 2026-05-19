import { jsonResponse, authRequired, forbidden } from '../utils.js';
import { getAuth } from '../jwt.js';
import { getUser, getUserById, listUsers, putUser, deleteUser, syncGalleryAssignments, stripSensitive } from '../kv.js';
import { hashPassword } from '../crypto.js';

export async function handleAdminListUsers(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  const users = await listUsers(env.KV);
  return jsonResponse(users.map(stripSensitive));
}

export async function handleAdminCreateUser(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  const { email, password, role = 'client', galleries = [] } = await request.json();
  if (!email) return jsonResponse({ error: 'Email required' }, 400);
  if (await getUser(email, env.KV)) return jsonResponse({ error: 'User already exists' }, 409);
  const id   = crypto.randomUUID();
  const user = {
    id, email: email.toLowerCase(),
    passwordHash: password ? await hashPassword(password) : null,
    role, created: Date.now(), galleries,
    verified: true,
  };
  await putUser(user, env.KV);
  if (galleries.length) await syncGalleryAssignments(user.email, galleries, [], env.KV);
  return jsonResponse(stripSensitive(user), 201);
}

export async function handleAdminUpdateUser(request, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  const user = await getUserById(id, env.KV);
  if (!user) return jsonResponse({ error: 'Not found' }, 404);
  const { password, role, galleries } = await request.json();
  const oldGalleries = user.galleries || [];
  const newGalleries = galleries !== undefined ? galleries : oldGalleries;
  if (password) user.passwordHash = await hashPassword(password);
  if (role !== undefined) user.role = role;
  user.galleries = newGalleries;
  await putUser(user, env.KV);
  const added   = newGalleries.filter(g => !oldGalleries.includes(g));
  const removed = oldGalleries.filter(g => !newGalleries.includes(g));
  if (added.length || removed.length) await syncGalleryAssignments(user.email, added, removed, env.KV);
  return jsonResponse(stripSensitive(user));
}

export async function handleAdminDeleteUser(request, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  const user = await getUserById(id, env.KV);
  if (!user) return jsonResponse({ error: 'Not found' }, 404);
  await syncGalleryAssignments(user.email, [], user.galleries || [], env.KV);
  await deleteUser(user.email, env.KV);
  return jsonResponse({ ok: true });
}
