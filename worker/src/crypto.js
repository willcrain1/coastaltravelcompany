// PBKDF2-SHA256 password hashing — shared by auth.js and admin/users.js

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km   = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, km, 256
  );
  const out = new Uint8Array(48);
  out.set(salt);
  out.set(new Uint8Array(bits), 16);
  return btoa(String.fromCharCode(...out));
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const combined = Uint8Array.from(atob(stored), c => c.charCodeAt(0));
  const salt     = combined.slice(0, 16);
  const expected = combined.slice(16);
  const km = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, km, 256
  );
  const hash = new Uint8Array(bits);
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ expected[i];
  return diff === 0;
}
