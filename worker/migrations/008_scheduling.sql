CREATE TABLE IF NOT EXISTS availability_windows (
  id          TEXT PRIMARY KEY,
  day_of_week INTEGER NOT NULL,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS blocked_dates (
  id      TEXT PRIMARY KEY,
  date    TEXT NOT NULL,
  reason  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS scheduling_links (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  link_type     TEXT NOT NULL DEFAULT 'discovery-call',
  duration_mins INTEGER NOT NULL DEFAULT 30,
  magic_token   TEXT UNIQUE NOT NULL,
  expires_at    TEXT NOT NULL DEFAULT '',
  booked_at     TEXT NOT NULL DEFAULT '',
  booked_slot   TEXT NOT NULL DEFAULT '',
  client_name   TEXT NOT NULL DEFAULT '',
  client_email  TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
