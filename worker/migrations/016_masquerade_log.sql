CREATE TABLE IF NOT EXISTS masquerade_log (
  id                TEXT PRIMARY KEY,
  admin_id          TEXT NOT NULL,
  admin_email       TEXT NOT NULL,
  target_user_id    TEXT NOT NULL,
  target_user_email TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  exited_at         TEXT
);
