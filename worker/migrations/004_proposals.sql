CREATE TABLE IF NOT EXISTS proposals (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  cover_note  TEXT NOT NULL DEFAULT '',
  expires_at  TEXT NOT NULL DEFAULT '',
  package_ids TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'sent',
  public_url  TEXT NOT NULL DEFAULT '',
  opened_at   TEXT NOT NULL DEFAULT '',
  view_count  INTEGER NOT NULL DEFAULT 0,
  time_spent_seconds INTEGER NOT NULL DEFAULT 0,
  selected_package_id TEXT NOT NULL DEFAULT '',
  selected_addons TEXT NOT NULL DEFAULT '[]',
  selected_at TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
