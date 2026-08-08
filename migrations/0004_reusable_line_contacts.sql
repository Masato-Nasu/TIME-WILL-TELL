CREATE TABLE IF NOT EXISTS line_contacts (
  id TEXT PRIMARY KEY,
  contact_token TEXT NOT NULL UNIQUE,
  connect_token TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  line_user_id TEXT,
  line_connected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE recipients ADD COLUMN line_contact_id TEXT;
CREATE INDEX IF NOT EXISTS idx_line_contacts_contact_token ON line_contacts(contact_token);
CREATE INDEX IF NOT EXISTS idx_line_contacts_connect_token ON line_contacts(connect_token);
CREATE INDEX IF NOT EXISTS idx_recipients_line_contact ON recipients(line_contact_id, delivery_status);
