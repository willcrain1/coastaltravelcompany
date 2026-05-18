CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  stage       TEXT NOT NULL DEFAULT 'Inquiry',
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  property    TEXT NOT NULL DEFAULT '',
  location    TEXT NOT NULL DEFAULT '',
  collection  TEXT NOT NULL DEFAULT '',
  shoot_date  TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'manual',
  labels      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_notes (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'note',
  content    TEXT NOT NULL,
  due_date   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
