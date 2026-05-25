-- Migration 012: 3D Walkthroughs
-- Adds splat_url to galleries (for client delivery) and creates walkthroughs
-- table for the public showcase page (/walkthroughs.html).

ALTER TABLE galleries ADD COLUMN splat_url TEXT;

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
