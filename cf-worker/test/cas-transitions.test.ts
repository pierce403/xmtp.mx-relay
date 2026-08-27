import { describe, expect, it } from 'vitest';
import type { RelayEnv } from '../src/bindings';
import {
  markDeliveryComplete,
  markDeliveryFailed,
  markOutboundFailed,
  type DeliveryJobRow,
  type OutboundRow,
} from '../src/db';

describe('absorbing delivery transitions', () => {
  it('terminalizes an outbound request only from the caller-observed predecessor', async () => {
    const statements: StatementRecord[] = [];
    const row = outboundRow({ status: 'sent', provider_message_id: 'provider-won-race' });
    const env = recordingEnv(statements, row);

    const actual = await markOutboundFailed(
      env,
      row.xmtp_msg_id,
      'failed',
      'dead_lettered_after_delivery_retries',
      'queued',
    );

    expect(statements[0]?.sql).toContain('WHERE xmtp_msg_id = ? AND status = ?');
    expect(statements[0]?.bound.slice(-2)).toEqual([row.xmtp_msg_id, 'queued']);
    expect(actual).toBe(row);
  });

  it('terminalizes a delivery job only from the caller-observed predecessor', async () => {
    const statements: StatementRecord[] = [];
    const row = deliveryJob({ status: 'delivered', xmtp_message_id: 'xmtp-won-race' });
    const env = recordingEnv(statements, row);

    const actual = await markDeliveryFailed(
      env,
      row.job_id,
      'dead_lettered_after_delivery_retries',
      'queued',
    );

    expect(statements[0]?.sql).toContain('WHERE job_id = ? AND status = ?');
    expect(statements[0]?.bound.slice(-2)).toEqual([row.job_id, 'queued']);
    expect(actual).toBe(row);
  });

  it('lets a definitive Container response win only over in-flight or uncertain state', async () => {
    const statements: StatementRecord[] = [];
    const row = deliveryJob({ status: 'delivered', xmtp_message_id: 'xmtp-message-id' });
    const env = recordingEnv(statements, row);

    const actual = await markDeliveryComplete(env, row, 'xmtp-message-id');

    expect(statements[0]?.sql).toContain("status IN ('delivering', 'uncertain')");
    expect(actual).toBe(row);
  });
});

type StatementRecord = { sql: string; bound: unknown[] };

function recordingEnv(statements: StatementRecord[], selected: OutboundRow | DeliveryJobRow): RelayEnv {
  return {
    RELAY_DB: {
      prepare(sql: string) {
        const record = { sql, bound: [] as unknown[] };
        statements.push(record);
        return {
          bind(...values: unknown[]) {
            record.bound = values;
            return this;
          },
          async run() {
            return { meta: { changes: 0 } };
          },
          async first() {
            return selected;
          },
        };
      },
      async batch(prepared: unknown[]) {
        return prepared.map(() => ({ meta: { changes: 0 } }));
      },
    },
  } as unknown as RelayEnv;
}

function outboundRow(overrides: Partial<OutboundRow> = {}): OutboundRow {
  return {
    id: 1,
    xmtp_msg_id: 'message-1',
    from_inbox: 'a'.repeat(64),
    conversation_id: 'conversation-1',
    to_email: '["recipient@example.com"]',
    cc_email: '[]',
    bcc_email: '[]',
    subject: 'hello',
    text: 'body',
    html: null,
    reply_to: null,
    status: 'queued',
    provider_message_id: null,
    error: null,
    attempt_count: 0,
    result_delivered_at: null,
    created_at: '2026-08-27T00:00:00.000Z',
    updated_at: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}

function deliveryJob(overrides: Partial<DeliveryJobRow> = {}): DeliveryJobRow {
  return {
    job_id: 'inbound:1',
    kind: 'email.inbound.v1',
    record_key: '1',
    conversation_id: null,
    recipient_inbox_id: null,
    sender_inbox_id: null,
    payload_json: '{}',
    status: 'queued',
    attempt_count: 0,
    last_error: null,
    queued_at: null,
    delivered_at: null,
    xmtp_message_id: null,
    created_at: '2026-08-27T00:00:00.000Z',
    updated_at: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}
