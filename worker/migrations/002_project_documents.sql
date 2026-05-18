CREATE TABLE IF NOT EXISTS project_documents (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'proposal',
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

