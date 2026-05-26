import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJWT } from '../../src/jwt.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dir, '../../migrations');

export const SECRET = 'test-jwt-secret-at-least-32-chars!!';
export const ORIGIN = 'https://coastaltravelcompany.com';

export function makeKv() {
  const store = new Map();
  return {
    _store: store,
    get:    async (k, _o)    => store.get(k) ?? null,
    put:    async (k, v, _o) => { store.set(k, v); },
    delete: async (k)        => { store.delete(k); },
  };
}

export function makeSqliteDb() {
  const db = new Database(':memory:');
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  return db;
}

// Wrap a better-sqlite3 DB instance in a D1-shaped async API.
export function makeD1(db) {
  const adapt = (sql, args) => ({
    all()  { return Promise.resolve({ results: db.prepare(sql).all(...args) }); },
    run()  { db.prepare(sql).run(...args); return Promise.resolve({}); },
    first(){ return Promise.resolve(db.prepare(sql).get(...args) ?? null); },
  });
  return {
    prepare(sql) {
      return {
        bind(...args) { return adapt(sql, args); },
        all()  { return Promise.resolve({ results: db.prepare(sql).all() }); },
        run()  { db.prepare(sql).run(); return Promise.resolve({}); },
        first(){ return Promise.resolve(db.prepare(sql).get() ?? null); },
      };
    },
  };
}

export function makeEnv(kv, d1 = null) {
  return { KV: kv, JWT_SECRET: SECRET, ...(d1 ? { DB: d1 } : {}) };
}

export async function adminToken() {
  return createJWT(
    { sub: 'admin@t.com', id: 'aid', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET,
  );
}

export async function clientToken() {
  return createJWT(
    { sub: 'client@t.com', id: 'cid', role: 'client', exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET,
  );
}

export function req(method, path, { token, body, extraHeaders = {} } = {}) {
  return new Request(`http://worker${path}`, {
    method,
    headers: {
      'Origin': ORIGIN,
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
