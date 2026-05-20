CREATE TABLE IF NOT EXISTS store_photos (
  id                              TEXT PRIMARY KEY,
  gallery_id                      TEXT NOT NULL,
  nas_photo_id                    INTEGER NOT NULL,
  title                           TEXT NOT NULL DEFAULT '',
  description                     TEXT NOT NULL DEFAULT '',
  personal_price_cents            INTEGER NOT NULL DEFAULT 0,
  commercial_digital_price_cents  INTEGER NOT NULL DEFAULT 0,
  commercial_print_price_cents    INTEGER NOT NULL DEFAULT 0,
  exclusive_price_cents           INTEGER NOT NULL DEFAULT 0,
  featured                        INTEGER NOT NULL DEFAULT 0,
  status                          TEXT NOT NULL DEFAULT 'active',
  created_at                      TEXT NOT NULL,
  updated_at                      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photo_purchases (
  id                       TEXT PRIMARY KEY,
  store_photo_id           TEXT NOT NULL REFERENCES store_photos(id),
  user_id                  TEXT,
  email                    TEXT NOT NULL DEFAULT '',
  buyer_name               TEXT NOT NULL DEFAULT '',
  license_type             TEXT NOT NULL,
  price_cents              INTEGER NOT NULL DEFAULT 0,
  stripe_session_id        TEXT NOT NULL DEFAULT '',
  stripe_payment_intent_id TEXT NOT NULL DEFAULT '',
  download_token           TEXT NOT NULL UNIQUE,
  download_expires_at      TEXT NOT NULL DEFAULT '',
  purchased_at             TEXT NOT NULL DEFAULT ''
);
