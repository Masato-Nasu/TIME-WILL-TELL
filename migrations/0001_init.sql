PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  public_token TEXT NOT NULL UNIQUE,
  admin_token TEXT NOT NULL UNIQUE,
  trigger_token TEXT UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('date', 'when')),
  body_enc TEXT NOT NULL,
  condition_enc TEXT,
  trigger_owner TEXT,
  send_at INTEGER,
  triggered_at INTEGER,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'sealed' CHECK (status IN ('sealed', 'released')),
  attachment_key TEXT,
  attachment_filename_enc TEXT,
  attachment_type TEXT,
  attachment_size INTEGER,
  delivered_started_at INTEGER,
  delivered_at INTEGER
);

CREATE TABLE IF NOT EXISTS recipients (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'line')),
  address TEXT,
  label TEXT,
  line_user_id TEXT,
  connect_token TEXT UNIQUE,
  line_connected_at INTEGER,
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'waiting_line', 'sent', 'failed')),
  delivered_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS creation_log (
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_due ON messages(mode, status, send_at);
CREATE INDEX IF NOT EXISTS idx_recipients_message ON recipients(message_id, delivery_status);
CREATE INDEX IF NOT EXISTS idx_creation_log ON creation_log(ip_hash, created_at);
