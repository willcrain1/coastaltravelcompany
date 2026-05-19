import { jsonResponse, authRequired, forbidden } from '../utils.js';
import { getAuth } from '../jwt.js';
import { getGallery, putGallery, deleteGallery, listGalleries, getUser, putUser, stripGallery } from '../kv.js';

export async function handleAdminListGalleries(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  return jsonResponse((await listGalleries(env.KV)).map(stripGallery));
}

export async function handleAdminCreateGallery(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  const gallery = await request.json();
  if (!gallery.id) gallery.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (!gallery.assignedUsers) gallery.assignedUsers = [];
  await putGallery(gallery, env.KV);
  return jsonResponse(stripGallery(gallery), 201);
}

export async function handleAdminUpdateGallery(request, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  const existing = await getGallery(id, env.KV);
  if (!existing) return jsonResponse({ error: 'Not found' }, 404);
  const updates = await request.json();
  const updated = { ...existing, ...updates, id };
  await putGallery(updated, env.KV);
  return jsonResponse(stripGallery(updated));
}

export async function handleAdminDeleteGallery(request, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  const gallery = await getGallery(id, env.KV);
  if (gallery) {
    for (const email of (gallery.assignedUsers || [])) {
      const u = await getUser(email, env.KV);
      if (u) {
        u.galleries = (u.galleries || []).filter(g => g !== id);
        await putUser(u, env.KV);
      }
    }
  }
  await deleteGallery(id, env.KV);
  return jsonResponse({ ok: true });
}
