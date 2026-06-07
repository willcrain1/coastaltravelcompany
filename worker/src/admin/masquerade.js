import { jsonResponse, authRequired, forbidden } from '../utils.js';
import { getAuth, createJWT } from '../jwt.js';
import { getUserById } from '../kv.js';

const MASQUERADE_TTL = 30 * 60;

export async function handleAdminMasqueradeStart(request, env) {
  const p = await getAuth(request, env);
  if (!p) return authRequired();
  if (p.role !== 'admin') return forbidden();
  if (p.masquerade) return jsonResponse({ error: 'Cannot initiate masquerade from within a masquerade session' }, 403);
  if (!env.JWT_SECRET) return jsonResponse({ error: 'JWT_SECRET not configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid body' }, 400); }
  const { target_user_id } = body;
  if (!target_user_id) return jsonResponse({ error: 'target_user_id required' }, 400);

  const target = await getUserById(target_user_id, env.KV);
  if (!target) return jsonResponse({ error: 'User not found' }, 404);
  if (target.role === 'admin') return jsonResponse({ error: 'Cannot masquerade an admin account' }, 403);

  const now = Math.floor(Date.now() / 1000);
  const masqueradeToken = await createJWT(
    {
      sub:         target.email,
      id:          target.id,
      role:        target.role,
      masquerade:  true,
      admin_id:    p.id,
      admin_email: p.sub,
      iat:         now,
      exp:         now + MASQUERADE_TTL,
    },
    env.JWT_SECRET
  );

  if (env.DB) {
    await env.DB.prepare(
      'INSERT INTO masquerade_log (id,admin_id,admin_email,target_user_id,target_user_email,started_at) VALUES (?,?,?,?,?,?)'
    ).bind(crypto.randomUUID(), p.id, p.sub, target.id, target.email, new Date().toISOString()).run().catch(() => {});
  }

  return jsonResponse({
    masquerade_token: masqueradeToken,
    target_user: { id: target.id, email: target.email, name: target.name || '' },
  });
}

export async function handleAdminMasqueradeExit(request, env) {
  const p = await getAuth(request, env);
  if (!p || !p.masquerade) return jsonResponse({ error: 'No active masquerade session' }, 400);

  if (env.DB) {
    await env.DB.prepare(
      `UPDATE masquerade_log SET exited_at = ? WHERE id = (
        SELECT id FROM masquerade_log
        WHERE target_user_id = ? AND admin_id = ? AND exited_at IS NULL
        ORDER BY started_at DESC LIMIT 1
      )`
    ).bind(new Date().toISOString(), p.id, p.admin_id).run().catch(() => {});
  }

  return jsonResponse({ ok: true });
}
