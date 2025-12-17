import type Database from 'better-sqlite3';
import type { Persistence } from '@xmtp/xmtp-js';

export class XmtpSqlitePersistence implements Persistence {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async getItem(key: string): Promise<Uint8Array | null> {
    const row = this.db.prepare('SELECT value FROM xmtp_kv WHERE key = ?').get(key) as
      | { value: Buffer }
      | undefined;
    if (!row) return null;
    return Uint8Array.from(row.value);
  }

  async setItem(key: string, value: Uint8Array): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO xmtp_kv(key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
        `,
      )
      .run(key, Buffer.from(value), now);
  }
}

