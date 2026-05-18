CREATE TABLE IF NOT EXISTS automation_settings (
  id          TEXT PRIMARY KEY,
  trigger_key TEXT UNIQUE NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 0,
  delay_hours INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_logs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  trigger_key TEXT NOT NULL,
  action      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'sent',
  created_at  TEXT NOT NULL
);

INSERT OR IGNORE INTO automation_settings (id, trigger_key, label, enabled, delay_hours, updated_at) VALUES
  ('a1', 'inquiry_auto_reply',             'Auto-reply on new inquiry',                  0, 0,   datetime('now')),
  ('a2', 'proposal_not_opened_followup',   'Follow up if proposal not opened (3 days)',  0, 72,  datetime('now')),
  ('a3', 'proposal_not_approved_reminder', 'Reminder if proposal not approved (7 days)', 0, 168, datetime('now')),
  ('a4', 'contract_not_signed_reminder',   'Reminder if contract not signed (2 days)',   0, 48,  datetime('now')),
  ('a5', 'gallery_delivered_notification', 'Notify client on gallery delivery',           0, 0,   datetime('now')),
  ('a6', 'post_delivery_review_request',   'Review request 2 weeks after delivery',       0, 336, datetime('now'));
