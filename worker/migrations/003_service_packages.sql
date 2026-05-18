CREATE TABLE IF NOT EXISTS service_packages (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  inclusions  TEXT NOT NULL DEFAULT '',
  hero_photo  TEXT NOT NULL DEFAULT '',
  base_price  INTEGER NOT NULL DEFAULT 0,
  addons      TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

