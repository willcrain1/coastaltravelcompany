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
  const { email, password, role = 'client', galleries = [], name } = await request.json();
  if (!email) return jsonResponse({ error: 'Email required' }, 400);
  if (await getUser(email, env.KV)) return jsonResponse({ error: 'User already exists' }, 409);
  const id   = crypto.randomUUID();
  const user = {
    id, email: email.toLowerCase(),
    name: name ? name.trim() : '',
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
  const { password, role, galleries, name } = await request.json();
  const oldGalleries = user.galleries || [];
  const newGalleries = galleries !== undefined ? galleries : oldGalleries;
  if (password) user.passwordHash = await hashPassword(password);
  if (role !== undefined) user.role = role;
  if (name !== undefined) user.name = name.trim();
  user.galleries = newGalleries;
  await putUser(user, env.KV);
  const added   = newGalleries.filter(g => !oldGalleries.includes(g));
  const removed = oldGalleries.filter(g => !newGalleries.includes(g));
  if (added.length || removed.length) await syncGalleryAssignments(user.email, added, removed, env.KV);
  return jsonResponse(stripSensitive(user));
}

export async function handleAdminUpdateUserRole(request, env, id) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();

  const user = await getUserById(id, env.KV);
  if (!user) return jsonResponse({ error: 'Not found' }, 404);

  if (p.id === id) return jsonResponse({ error: 'Cannot change your own role' }, 403);

  const { role } = await request.json();
  if (role !== 'client' && role !== 'admin') {
    return jsonResponse({ error: 'Role must be "client" or "admin"' }, 400);
  }

  const oldRole = user.role;
  user.role = role;
  await putUser(user, env.KV);

  if (env.DB) {
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO user_role_audit (id,acting_admin_email,target_user_id,target_user_email,old_role,new_role,changed_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(crypto.randomUUID(), p.sub, id, user.email, oldRole, role, now).run().catch(() => {});
  }

  if (env.RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'Coastal Travel Company <noreply@coastaltravelcompany.com>',
        to:      [user.email],
        subject: 'Your account has been updated — Coastal Travel Company',
        html:    `<p style="font-family:sans-serif;font-size:15px">Your Coastal Travel Company account role has been updated.</p>
<p style="font-family:sans-serif;font-size:15px">Your role has been changed from <strong>${oldRole}</strong> to <strong>${role}</strong> by an administrator.</p>
<p style="font-family:sans-serif;font-size:13px;color:#999">If you have questions about this change, please contact us.</p>`,
      }),
    }).catch(() => {});
  }

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
