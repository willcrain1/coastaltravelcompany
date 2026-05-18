CREATE TABLE IF NOT EXISTS questionnaire_sets (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  phase      TEXT NOT NULL DEFAULT 'pre-booking',
  questions  TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

