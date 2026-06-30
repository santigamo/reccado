CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  zone_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mailboxes (
  mailbox_id TEXT PRIMARY KEY,
  primary_address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE aliases (
  alias_address TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(mailbox_id),
  domain_id TEXT NOT NULL REFERENCES domains(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE routing_rules (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id),
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('store', 'forward', 'reject')),
  mailbox_id TEXT REFERENCES mailboxes(mailbox_id),
  forward_to_json TEXT NOT NULL DEFAULT '[]',
  reject_reason TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_aliases_mailbox ON aliases(mailbox_id);
CREATE INDEX idx_routing_rules_domain ON routing_rules(domain_id, priority);
