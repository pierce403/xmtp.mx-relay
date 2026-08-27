-- Cloudflare-native relay application state. The XMTP SDK database is backed
-- up separately to R2 and is never stored in D1.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS inbound_email (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  message_id TEXT,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  header_from TEXT,
  header_to TEXT,
  subject TEXT NOT NULL DEFAULT '',
  text TEXT,
  html TEXT,
  thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  xmtp_message_id TEXT,
  xmtp_delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS inbound_email_status_idx
  ON inbound_email(status, updated_at);

CREATE TABLE IF NOT EXISTS outbound_request (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  xmtp_msg_id TEXT NOT NULL UNIQUE,
  from_inbox TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  to_email TEXT,
  cc_email TEXT,
  bcc_email TEXT,
  subject TEXT,
  text TEXT,
  html TEXT,
  reply_to TEXT,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS outbound_request_status_idx
  ON outbound_request(status, updated_at);

CREATE TABLE IF NOT EXISTS allowlist_xmtp (
  sender_inbox_or_address TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_map (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS thread_map_thread_id_idx
  ON thread_map(thread_id);

CREATE TABLE IF NOT EXISTS delivery_job (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  record_key TEXT NOT NULL,
  conversation_id TEXT,
  recipient_inbox_id TEXT,
  sender_inbox_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at TEXT,
  delivered_at TEXT,
  xmtp_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS delivery_job_status_idx
  ON delivery_job(status, updated_at);

CREATE TABLE IF NOT EXISTS queue_failure (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_name TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  error TEXT NOT NULL,
  failed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS queue_failure_failed_at_idx
  ON queue_failure(failed_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS queue_failure_job_idx
  ON queue_failure(queue_name, job_id);

CREATE TABLE IF NOT EXISTS relay_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Independent monotonic anchor for the signed R2 latest manifest. R2 object
-- history/signatures alone do not prove freshness after a rollback.
CREATE TABLE IF NOT EXISTS snapshot_anchor (
  object_key TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
