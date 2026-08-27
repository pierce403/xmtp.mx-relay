import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RelayEnv } from '../cf-worker/src/bindings';
import {
  claimDeliveryJob,
  claimOutboundRequest,
  createInboundDeliveryJob,
  createResultDeliveryJob,
  getDeliveryJob,
  getInboundEmail,
  getOutboundRequest,
  insertInboundEmail,
  insertOutboundRequest,
  isAllowlisted,
  listRecoverableWork,
  markDeliveryComplete,
  markDeliveryQueued,
  markDeliveryRetry,
  markOutboundQueued,
  markOutboundSent,
  recordQueueFailure,
  seedConfiguredAllowlist,
} from '../cf-worker/src/db';
import { makeEmailSendResult, type EmailSendV1, type XmtpEvent } from '../cf-worker/src/protocol';

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(path.join(here, '..', 'cf-worker', 'migrations', '0001_cloudflare_relay.sql'), 'utf8');

let sqlite: Database.Database;
let env: RelayEnv;
const allowedInbox = 'aa'.repeat(32);
const secondInbox = 'bb'.repeat(32);

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.exec(migration);
  env = {
    RELAY_DB: d1Adapter(sqlite),
    XMTP_ALLOWED_SENDERS: `${allowedInbox}, ${secondInbox.toUpperCase()} `,
  } as RelayEnv;
});

afterEach(async () => {
  sqlite?.close();
});

function d1Adapter(db: Database.Database): D1Database {
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const api = {
      bind(...input: unknown[]) {
        values = input;
        return api;
      },
      async first<T>() {
        return (db.prepare(sql).get(...values) as T | undefined) ?? null;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...values) as T[], success: true, meta: {} };
      },
      async run() {
        const result = db.prepare(sql).run(...values);
        return {
          success: true,
          results: [],
          meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) },
        };
      },
      async raw<T>() {
        return db.prepare(sql).raw(true).all(...values) as T[];
      },
    };
    return api;
  };
  return {
    prepare,
    async batch(statements: Array<ReturnType<typeof prepare>>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    withSession() {
      throw new Error('withSession is not used by relay DB tests');
    },
  } as unknown as D1Database;
}

describe('inbound email idempotency (A/D)', () => {
  it('stores one durable record and one delivery job for duplicate SMTP delivery', async () => {
    const input = {
      dedupeKey: '<same-message@example.com>',
      messageId: '<same-message@example.com>',
      envelopeFrom: 'sender@example.com',
      envelopeTo: 'deanpierce.eth@xmtp.mx',
      headerFrom: 'Sender <sender@example.com>',
      headerTo: 'deanpierce.eth@xmtp.mx',
      subject: 'test',
      text: 'plain',
      html: '<p>html</p>',
      threadId: '<same-message@example.com>',
      receivedAt: '2026-08-27T00:00:00.000Z',
    };

    const first = await insertInboundEmail(env, input);
    const replay = await insertInboundEmail(env, input);
    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.row.id).toBe(first.row.id);

    const firstJob = await createInboundDeliveryJob(env, first.row);
    const replayJob = await createInboundDeliveryJob(env, replay.row);
    expect(replayJob.job_id).toBe(firstJob.job_id);
    expect(JSON.parse(firstJob.payload_json)).toEqual({
      type: 'email.inbound.v1',
      to: 'deanpierce.eth@xmtp.mx',
      from: 'sender@example.com',
      subject: 'test',
      text: 'plain',
      html: '<p>html</p>',
      messageId: '<same-message@example.com>',
      receivedAt: '2026-08-27T00:00:00.000Z',
    });

    await markDeliveryQueued(env, firstJob.job_id);
    expect(await claimDeliveryJob(env, firstJob.job_id)).toBe(true);
    expect(await claimDeliveryJob(env, firstJob.job_id)).toBe(false);
    await markDeliveryComplete(env, firstJob, 'xmtp-delivery-id');

    const inbound = await getInboundEmail(env, first.row.id);
    expect(inbound).toMatchObject({
      status: 'delivered',
      xmtp_message_id: 'xmtp-delivery-id',
      attempt_count: 1,
    });
    expect(await env.RELAY_DB.prepare('SELECT COUNT(*) AS count FROM inbound_email').first()).toEqual({ count: 1 });
    expect(await env.RELAY_DB.prepare('SELECT COUNT(*) AS count FROM delivery_job').first()).toEqual({ count: 1 });
  });
});

describe('outbound XMTP idempotency and authorization state (B/C/E)', () => {
  const request: EmailSendV1 = {
    type: 'email.send.v1',
    to: ['to@example.com'],
    cc: ['cc@example.com'],
    bcc: ['bcc@example.com'],
    subject: 'subject',
    text: 'text',
    html: '<p>html</p>',
    replyTo: 'reply@example.com',
  };
  const event: XmtpEvent = {
    messageId: 'xmtp-request-id',
    senderInboxId: allowedInbox,
    conversationId: 'conversation-id',
    content: JSON.stringify(request),
    receivedAt: '2026-08-27T00:00:00.000Z',
  };

  it('normalizes and enforces the configured allowlist', async () => {
    await seedConfiguredAllowlist(env);
    expect(await isAllowlisted(env, allowedInbox.toUpperCase())).toBe(true);
    expect(await isAllowlisted(env, secondInbox)).toBe(true);
    expect(await isAllowlisted(env, 'cc'.repeat(32))).toBe(false);
  });

  it('creates one outbound request and result job for a replayed XMTP message', async () => {
    const first = await insertOutboundRequest(env, event, request, 'received', null);
    const replay = await insertOutboundRequest(env, event, request, 'received', null);
    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.row.id).toBe(first.row.id);

    await markOutboundQueued(env, event.messageId);
    expect(await claimOutboundRequest(env, event.messageId)).toBe(true);
    expect(await claimOutboundRequest(env, event.messageId)).toBe(false);
    const sent = await markOutboundSent(env, event.messageId, 'cloudflare-provider-id');
    const result = makeEmailSendResult({ ok: true, providerMessageId: sent.provider_message_id });
    const firstJob = await createResultDeliveryJob(env, sent, result);
    const replayJob = await createResultDeliveryJob(env, sent, result);

    expect(replayJob.job_id).toBe(firstJob.job_id);
    expect(JSON.parse(firstJob.payload_json)).toEqual({
      type: 'email.send.result.v1',
      ok: true,
      providerMessageId: 'cloudflare-provider-id',
      error: null,
    });
    expect(await env.RELAY_DB.prepare('SELECT COUNT(*) AS count FROM outbound_request').first()).toEqual({ count: 1 });
    expect(await env.RELAY_DB.prepare('SELECT COUNT(*) AS count FROM delivery_job').first()).toEqual({ count: 1 });
  });

  it('durably records a denied sender without producing a sendable request', async () => {
    const denied = await insertOutboundRequest(
      env,
      { ...event, messageId: 'denied-message', senderInboxId: 'cc'.repeat(32) },
      null,
      'denied',
      'not_allowlisted',
    );
    expect(denied.row).toMatchObject({
      status: 'denied',
      error: 'not_allowlisted',
      to_email: null,
      cc_email: null,
      bcc_email: null,
    });
    expect(await claimOutboundRequest(env, 'denied-message')).toBe(false);
  });
});

describe('durable retry and dead-letter visibility (H)', () => {
  it('makes transient XMTP delivery retryable and records the second claim', async () => {
    const inserted = await insertInboundEmail(env, {
      dedupeKey: '<retry@example.com>',
      messageId: '<retry@example.com>',
      envelopeFrom: 'sender@example.com',
      envelopeTo: 'deanpierce.eth@xmtp.mx',
      headerFrom: null,
      headerTo: null,
      subject: 'retry',
      text: 'retry',
      html: null,
      threadId: null,
      receivedAt: '2026-08-27T00:00:00.000Z',
    });
    const job = await createInboundDeliveryJob(env, inserted.row);
    await markDeliveryQueued(env, job.job_id);

    expect(await claimDeliveryJob(env, job.job_id)).toBe(true);
    await markDeliveryRetry(env, job.job_id, 'container returned 503');
    // Once a broker handoff is confirmed, retrying remains Queue-owned. The
    // short-gap sweeper must not inject a fresh attempt=1 message and reset the
    // configured retry/DLQ budget.
    expect((await listRecoverableWork(env)).deliveryJobIds).not.toContain(job.job_id);
    expect(await claimDeliveryJob(env, job.job_id)).toBe(true);
    await markDeliveryComplete(env, job, 'xmtp-id-after-retry');

    expect(await getDeliveryJob(env, job.job_id)).toMatchObject({
      status: 'delivered',
      attempt_count: 2,
      last_error: null,
      xmtp_message_id: 'xmtp-id-after-retry',
    });
  });

  it('persists dead-letter metadata for operator visibility', async () => {
    await recordQueueFailure(env, 'xmtp-mx-xmtp-delivery-dlq', 'inbound:9', 5, 'container unavailable');
    expect(await env.RELAY_DB.prepare('SELECT * FROM queue_failure').first()).toMatchObject({
      queue_name: 'xmtp-mx-xmtp-delivery-dlq',
      job_id: 'inbound:9',
      attempts: 5,
      error: 'container unavailable',
    });
  });
});
