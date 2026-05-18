CREATE TABLE IF NOT EXISTS questionnaire_instances (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  set_id       TEXT NOT NULL,
  magic_token  TEXT UNIQUE NOT NULL,
  phase        TEXT NOT NULL DEFAULT 'pre-booking',
  status       TEXT NOT NULL DEFAULT 'sent',
  sent_at      TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT '',
  responses    TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
