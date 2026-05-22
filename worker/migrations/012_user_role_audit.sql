CREATE TABLE IF NOT EXISTS user_role_audit (
  id                 TEXT PRIMARY KEY,
  acting_admin_email TEXT NOT NULL,
  target_user_id     TEXT NOT NULL,
  target_user_email  TEXT NOT NULL,
  old_role           TEXT NOT NULL,
  new_role           TEXT NOT NULL,
  changed_at         TEXT NOT NULL
);
