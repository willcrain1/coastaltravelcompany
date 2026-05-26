import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dir, '../migrations');

const EXPECTED_TABLES = [
  'automation_logs', 'automation_settings', 'availability_windows',
  'blocked_dates', 'contract_signing_events', 'contract_templates', 'contracts',
  'invoices', 'project_documents', 'project_messages', 'project_notes',
  'project_portal_tokens', 'projects', 'proposals', 'questionnaire_instances',
  'questionnaire_sets', 'scheduling_links', 'service_packages', 'user_role_audit',
  'walkthroughs',
];

function applyAll(db) {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  return files;
}

describe('D1 migration smoke tests', () => {
  it('all migrations apply without throwing', () => {
    const db = new Database(':memory:');
    expect(() => applyAll(db)).not.toThrow();
  });

  it('creates every expected table', () => {
    const db = new Database(':memory:');
    applyAll(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map(r => r.name);
    for (const t of EXPECTED_TABLES) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }
  });

  it('covers all 13 migration files', () => {
    const files = applyAll(new Database(':memory:'));
    expect(files).toHaveLength(13);
  });

  it('migrations are idempotent — re-running does not throw', () => {
    const db = new Database(':memory:');
    applyAll(db);
    expect(() => applyAll(db)).not.toThrow();
  });

  it('automation_settings seeded with 6 rows on first run', () => {
    const db = new Database(':memory:');
    applyAll(db);
    const count = db.prepare('SELECT COUNT(*) AS c FROM automation_settings').get().c;
    expect(count).toBe(6);
  });

  it('re-running does not duplicate seeded automation_settings rows', () => {
    const db = new Database(':memory:');
    applyAll(db);
    const before = db.prepare('SELECT COUNT(*) AS c FROM automation_settings').get().c;
    applyAll(db);
    const after = db.prepare('SELECT COUNT(*) AS c FROM automation_settings').get().c;
    expect(after).toBe(before);
  });

  it('projects table has expected columns', () => {
    const db = new Database(':memory:');
    applyAll(db);
    const cols = db.prepare('PRAGMA table_info(projects)').all().map(r => r.name);
    for (const c of ['id', 'stage', 'client_name', 'client_email', 'created_at', 'updated_at']) {
      expect(cols, `missing column projects.${c}`).toContain(c);
    }
  });

  it('contracts table has signing token unique constraint', () => {
    const db = new Database(':memory:');
    applyAll(db);
    const now = new Date().toISOString();
    const insert = db.prepare(
      'INSERT INTO contracts (id,project_id,title,body,signing_token,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    );
    db.prepare('INSERT INTO projects (id,client_name,client_email,created_at,updated_at) VALUES (?,?,?,?,?)').run('p1', 'A', 'a@t.com', now, now);
    insert.run('c1', 'p1', 'T', 'B', 'tok-x', now, now);
    expect(() => insert.run('c2', 'p1', 'T', 'B', 'tok-x', now, now)).toThrow();
  });
});
