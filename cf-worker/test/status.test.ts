import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RelayEnv } from '../src/bindings';
import { getStatusSnapshot } from '../src/db';

describe('authenticated status D1 snapshot', () => {
  afterEach(() => vi.useRealTimers());

  it('reports durable backlog ages and recent DLQ failures without claiming broker depth', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));

    const env = {
      RELAY_DB: {
        prepare: (sql: string) => ({
          all: async () => selectAll(sql),
          first: async () => selectFirst(sql),
        }),
      },
    } as unknown as RelayEnv;

    const snapshot = await getStatusSnapshot(env);

    expect(seenOldestPendingQuery).toContain("status IN ('received', 'queued', 'retrying', 'sending')");
    expect(seenOldestPendingQuery).toContain("status IN ('received', 'queued', 'retrying', 'delivering')");

    expect(snapshot.oldestPending).toEqual({
      inbound_email: { updatedAt: '2026-08-27T11:58:00.000Z', ageSeconds: 120 },
      outbound_request: null,
      xmtp_delivery: { updatedAt: '2026-08-27T11:59:30.000Z', ageSeconds: 30 },
    });
    expect(snapshot.recentQueueFailures).toEqual([{
      queue_name: 'xmtp-mx-email-delivery-dlq-production',
      job_id: 'outbound-1',
      attempts: 9,
      error: 'dead_lettered_after_delivery_retries',
      failed_at: '2026-08-27T11:59:00.000Z',
    }]);
    expect(snapshot).not.toHaveProperty('queueDepth');
  });
});

let seenOldestPendingQuery = '';

function selectAll(sql: string): { results: Record<string, unknown>[] } {
  if (sql.includes("'inbound_email' AS source")) {
    seenOldestPendingQuery = sql;
    return { results: [
      { source: 'inbound_email', oldest_updated_at: '2026-08-27T11:58:00.000Z' },
      { source: 'outbound_request', oldest_updated_at: null },
      { source: 'xmtp_delivery', oldest_updated_at: '2026-08-27T11:59:30.000Z' },
    ] };
  }
  if (sql.includes('FROM queue_failure ORDER BY id DESC')) {
    return { results: [{
      queue_name: 'xmtp-mx-email-delivery-dlq-production',
      job_id: 'outbound-1',
      attempts: 9,
      error: 'dead_lettered_after_delivery_retries',
      failed_at: '2026-08-27T11:59:00.000Z',
    }] };
  }
  return { results: [] };
}

function selectFirst(sql: string): Record<string, unknown> | null {
  if (sql.includes('COUNT(*) AS count FROM queue_failure')) return { count: 1 };
  return null;
}
