-- Migration 013: 3D Walkthroughs
-- Creates walkthroughs table for the public showcase page (/walkthroughs.html).
-- Note: splat_url for gallery delivery is stored in KV alongside other gallery
-- data, not in D1, so no ALTER TABLE is needed here.

CREATE TABLE IF NOT EXISTS walkthroughs (
  id           TEXT    PRIMARY KEY,
  title        TEXT    NOT NULL,
  property_name TEXT   NOT NULL,
  location     TEXT,
  description  TEXT,
  embed_url    TEXT    NOT NULL,
  thumbnail_url TEXT,
  collection   TEXT,
  sort_order   INTEGER DEFAULT 0,
  published    INTEGER DEFAULT 0,
  created_at   TEXT    DEFAULT (datetime('now'))
);
