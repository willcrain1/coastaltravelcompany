CREATE TABLE IF NOT EXISTS project_messages (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  sender      TEXT NOT NULL DEFAULT 'admin',
  sender_name TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_portal_tokens (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  expires_at  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
