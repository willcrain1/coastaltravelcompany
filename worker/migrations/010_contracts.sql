CREATE TABLE IF NOT EXISTS contract_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  collection_type TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  merge_fields TEXT NOT NULL DEFAULT '{}',
  signing_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'sent',
  client_name TEXT NOT NULL DEFAULT '',
  client_email TEXT NOT NULL DEFAULT '',
  client_signature TEXT NOT NULL DEFAULT '',
  client_signature_type TEXT NOT NULL DEFAULT '',
  client_signed_at TEXT NOT NULL DEFAULT '',
  client_ip TEXT NOT NULL DEFAULT '',
  client_ua TEXT NOT NULL DEFAULT '',
  admin_signature TEXT NOT NULL DEFAULT '',
  admin_signature_type TEXT NOT NULL DEFAULT '',
  admin_signed_at TEXT NOT NULL DEFAULT '',
  admin_ip TEXT NOT NULL DEFAULT '',
  admin_ua TEXT NOT NULL DEFAULT '',
  body_hash TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contract_signing_events (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  actor_email TEXT NOT NULL DEFAULT '',
  ip_address TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  body_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
