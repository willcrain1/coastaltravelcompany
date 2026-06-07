-- Migration 018: First-party privacy-friendly analytics (items 32 & 46)
-- Stores aggregate, anonymous clickstream/engagement events. Deliberately
-- excludes IP addresses, user agents, and any device fingerprinting — only an
-- ephemeral per-tab session_id (crypto.randomUUID, sessionStorage) ties events
-- together for the duration of a single visit.

CREATE TABLE IF NOT EXISTS analytics_events (
  id          TEXT    PRIMARY KEY,
  session_id  TEXT    NOT NULL,
  event_type  TEXT    NOT NULL,   -- pageview | conversion | scroll_depth | section_dwell | click
  page        TEXT    NOT NULL,   -- pathname, e.g. /collections.html
  label       TEXT,               -- event-specific label (section_id, link name, image title, etc.)
  value       INTEGER,            -- event-specific numeric payload (scroll %, dwell ms)
  referrer    TEXT,               -- document.referrer, truncated to origin+path
  utm_source  TEXT,
  utm_medium  TEXT,
  utm_campaign TEXT,
  created_at  TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_page_type ON analytics_events (page, event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created   ON analytics_events (created_at);
