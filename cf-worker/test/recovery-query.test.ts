import { describe, expect, it, vi } from 'vitest';
import type { RelayEnv } from '../src/bindings';
import {
  listAbandonedInflight,
  listOrphanedBrokerWork,
  listRecoverableWork,
  markDeliveryQueued,
  markOutboundQueued,
} from '../src/db';

describe('bounded outbox recovery', () => {
  it('selects only stale rows and excludes inbound rows with deterministic jobs', async () => {
    const prepared: Array<{ sql: string; bound: unknown[] }> = [];
    const env = recordingEnv(prepared, { results: [] });
    const staleBefore = '2026-08-27T02:55:00.000Z';

    await listRecoverableWork(env, staleBefore);

    expect(prepared).toHaveLength(4);
    for (const statement of prepared) {
      expect(statement.sql).toContain('updated_at <= ?');
      expect(statement.bound).toEqual([staleBefore]);
    }
    expect(prepared[0]?.sql).toContain("job_id = 'inbound:' || inbound_email.id");
    expect(prepared[0]?.sql).toContain("status = 'received'");
    expect(prepared[1]?.sql).toContain("status = 'received'");
    expect(prepared[1]?.sql).not.toContain('retrying');
    expect(prepared[2]?.sql).toContain("status IN ('sent', 'failed', 'uncertain', 'denied', 'invalid')");
    expect(prepared[2]?.sql).toContain("job_id = 'result:' || outbound_request.xmtp_msg_id");
    expect(prepared[3]?.sql).toContain("status = 'received'");
    expect(prepared[3]?.sql).not.toContain('retrying');
  });

  it('marks only confirmed first handoffs as queued', async () => {
    const prepared: Array<{ sql: string; bound: unknown[] }> = [];
    const env = recordingEnv(prepared, { meta: { changes: 1 } });

    await markDeliveryQueued(env, 'inbound:1');
    await markOutboundQueued(env, 'xmtp-message-1');

    expect(prepared[0]?.sql).toContain("status = 'received'");
    expect(prepared[0]?.sql).toContain('queued_at = ?');
    expect(prepared[1]?.sql).toContain("status = 'received'");
    expect(prepared[1]?.sql).toContain('updated_at = ?');
  });

  it('separately selects only long-abandoned in-flight claims', async () => {
    const prepared: Array<{ sql: string; bound: unknown[] }> = [];
    const env = recordingEnv(prepared, { results: [] });
    const staleBefore = '2026-08-26T20:00:00.000Z';

    await listAbandonedInflight(env, staleBefore);

    expect(prepared).toHaveLength(2);
    expect(prepared[0]?.sql).toContain("status = 'sending'");
    expect(prepared[0]?.sql).not.toContain("status = 'queued'");
    expect(prepared[0]?.sql).not.toContain("status = 'retrying'");
    expect(prepared[1]?.sql).toContain("status = 'delivering'");
    for (const statement of prepared) {
      expect(statement.sql).toContain('updated_at <= ?');
      expect(statement.bound).toEqual([staleBefore]);
    }
  });

  it('uses a separate long-horizon query for safe broker-owned orphan states', async () => {
    const prepared: Array<{ sql: string; bound: unknown[] }> = [];
    const env = recordingEnv(prepared, { results: [] });
    const staleBefore = '2026-08-26T00:00:00.000Z';

    await listOrphanedBrokerWork(env, staleBefore);

    expect(prepared).toHaveLength(2);
    expect(prepared[0]?.sql).toContain("status IN ('queued', 'retrying')");
    expect(prepared[0]?.sql).not.toContain("status = 'sending'");
    expect(prepared[1]?.sql).toContain("status IN ('queued', 'retrying')");
    expect(prepared[1]?.sql).not.toContain("status = 'delivering'");
    for (const statement of prepared) {
      expect(statement.sql).toContain('updated_at <= ?');
      expect(statement.bound).toEqual([staleBefore]);
    }
  });
});

function recordingEnv(
  prepared: Array<{ sql: string; bound: unknown[] }>,
  result: Record<string, unknown>,
): RelayEnv {
  return {
    RELAY_DB: {
      prepare(sql: string) {
        const record = { sql, bound: [] as unknown[] };
        prepared.push(record);
        return {
          bind(...values: unknown[]) {
            record.bound = values;
            return this;
          },
          async all() {
            return result;
          },
          async run() {
            return result;
          },
        };
      },
    },
  } as unknown as RelayEnv;
}
