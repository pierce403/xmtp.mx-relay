import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type InboundEmailInsert = {
  mailgunMessageId: string | null;
  messageId: string | null;
  from: string;
  to: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  receivedAt: string;
};

export type InboundEmailRow = {
  id: number;
  dedupe_key: string;
  mailgun_message_id: string | null;
  message_id: string | null;
  from: string;
  to: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  received_at: string;
  xmtp_sent_at: string | null;
};

export type OutboundRequestRow = {
  id: number;
  xmtp_msg_id: string;
  from_inbox: string;
  to_email: string;
  cc_email: string;
  bcc_email: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  status: 'received' | 'sending' | 'sent' | 'failed';
  mailgun_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export class RelayDb {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static open(dataDir: string): RelayDb {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'relay.sqlite');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    const relayDb = new RelayDb(db);
    relayDb.init();
    return relayDb;
  }

  raw(): Database.Database {
    return this.db;
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbound_email (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        mailgun_message_id TEXT,
        message_id TEXT,
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        subject TEXT,
        text TEXT,
        html TEXT,
        received_at TEXT NOT NULL,
        xmtp_sent_at TEXT
      );

      CREATE INDEX IF NOT EXISTS inbound_email_xmtp_sent_at_idx
        ON inbound_email(xmtp_sent_at);

      CREATE TABLE IF NOT EXISTS outbound_request (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        xmtp_msg_id TEXT NOT NULL UNIQUE,
        from_inbox TEXT NOT NULL,
        to_email TEXT NOT NULL,
        cc_email TEXT NOT NULL,
        bcc_email TEXT NOT NULL,
        subject TEXT,
        text TEXT,
        html TEXT,
        status TEXT NOT NULL,
        mailgun_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS outbound_request_status_idx
        ON outbound_request(status);

      CREATE TABLE IF NOT EXISTS allowlist_xmtp (
        sender_inbox_or_address TEXT PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS thread_map (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS xmtp_kv (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  seedAllowlist(values: string[]): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO allowlist_xmtp(sender_inbox_or_address) VALUES (?)',
    );
    const tx = this.db.transaction((items: string[]) => {
      for (const item of items) stmt.run(item.trim().toLowerCase());
    });
    tx(values);
  }

  isAllowlisted(senderInboxOrAddress: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM allowlist_xmtp WHERE sender_inbox_or_address = ?')
      .get(senderInboxOrAddress.trim().toLowerCase());
    return Boolean(row);
  }

  insertInboundEmail(input: InboundEmailInsert): { id: number } | null {
    const dedupeKey = computeInboundDedupeKey(input);
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO inbound_email(
        dedupe_key,
        mailgun_message_id,
        message_id,
        "from",
        "to",
        subject,
        text,
        html,
        received_at,
        xmtp_sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `);

    const result = stmt.run(
      dedupeKey,
      input.mailgunMessageId,
      input.messageId,
      input.from,
      input.to,
      input.subject,
      input.text,
      input.html,
      input.receivedAt,
    );

    if (result.changes === 0) return null;
    return { id: Number(result.lastInsertRowid) };
  }

  getInboundEmailById(id: number): InboundEmailRow | null {
    const row = this.db
      .prepare('SELECT * FROM inbound_email WHERE id = ?')
      .get(id) as InboundEmailRow | undefined;
    return row ?? null;
  }

  listUnsentInboundEmails(limit: number): InboundEmailRow[] {
    return this.db
      .prepare(
        'SELECT * FROM inbound_email WHERE xmtp_sent_at IS NULL ORDER BY id ASC LIMIT ?',
      )
      .all(limit) as InboundEmailRow[];
  }

  markInboundEmailSent(id: number, sentAt: string): void {
    this.db
      .prepare('UPDATE inbound_email SET xmtp_sent_at = ? WHERE id = ?')
      .run(sentAt, id);
  }

  getOutboundRequestByXmtpMsgId(xmtpMsgId: string): OutboundRequestRow | null {
    const row = this.db
      .prepare('SELECT * FROM outbound_request WHERE xmtp_msg_id = ?')
      .get(xmtpMsgId) as OutboundRequestRow | undefined;
    return row ?? null;
  }

  insertOutboundRequest(input: {
    xmtpMsgId: string;
    fromInbox: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string | null;
    text: string | null;
    html: string | null;
    createdAt: string;
  }): OutboundRequestRow {
    const toJson = JSON.stringify(input.to);
    const ccJson = JSON.stringify(input.cc);
    const bccJson = JSON.stringify(input.bcc);

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO outbound_request(
        xmtp_msg_id,
        from_inbox,
        to_email,
        cc_email,
        bcc_email,
        subject,
        text,
        html,
        status,
        mailgun_id,
        error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', NULL, NULL, ?, ?)
    `);

    stmt.run(
      input.xmtpMsgId,
      input.fromInbox,
      toJson,
      ccJson,
      bccJson,
      input.subject,
      input.text,
      input.html,
      input.createdAt,
      input.createdAt,
    );

    const existing = this.getOutboundRequestByXmtpMsgId(input.xmtpMsgId);
    if (!existing) {
      throw new Error('Failed to insert outbound_request');
    }
    return existing;
  }

  updateOutboundRequestStatus(
    xmtpMsgId: string,
    update: { status: OutboundRequestRow['status']; mailgunId?: string | null; error?: string | null },
    updatedAt: string,
  ): void {
    this.db
      .prepare(
        `
        UPDATE outbound_request
        SET status = ?,
            mailgun_id = COALESCE(?, mailgun_id),
            error = COALESCE(?, error),
            updated_at = ?
        WHERE xmtp_msg_id = ?
        `,
      )
      .run(update.status, update.mailgunId ?? null, update.error ?? null, updatedAt, xmtpMsgId);
  }
}

function computeInboundDedupeKey(input: InboundEmailInsert): string {
  const base = input.mailgunMessageId?.trim() || input.messageId?.trim();
  if (base) return base;

  const hash = crypto.createHash('sha256');
  hash.update(input.from);
  hash.update('\n');
  hash.update(input.to);
  hash.update('\n');
  hash.update(input.subject ?? '');
  hash.update('\n');
  hash.update(input.text ?? '');
  hash.update('\n');
  hash.update(input.receivedAt);
  return `sha256:${hash.digest('hex')}`;
}
