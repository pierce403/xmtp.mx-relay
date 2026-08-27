import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayEnv } from '../src/bindings';
import type { OutboundRow } from '../src/db';

const db = vi.hoisted(() => ({
  createResultDeliveryJob: vi.fn(),
  getOutboundRequest: vi.fn(),
  insertOutboundRequest: vi.fn(),
  isAllowlisted: vi.fn(),
  markDeliveryQueued: vi.fn(),
  markOutboundQueued: vi.fn(),
  seedConfiguredAllowlist: vi.fn(),
  setRelayState: vi.fn(),
}));

vi.mock('../src/db', () => db);

import { handleXmtpEventRequest } from '../src/events';

const ALLOWED_INBOX = 'a'.repeat(64);
const DENIED_INBOX = 'b'.repeat(64);

describe('authenticated XMTP event ingestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.seedConfiguredAllowlist.mockResolvedValue(undefined);
    db.markDeliveryQueued.mockResolvedValue(undefined);
    db.markOutboundQueued.mockResolvedValue(undefined);
    db.setRelayState.mockResolvedValue(undefined);
    db.createResultDeliveryJob.mockResolvedValue({
      job_id: 'result:message-denied',
      status: 'received',
    });
  });

  it('repairs a D1-commit/Queue-send gap when the Container replays an event', async () => {
    let stored: OutboundRow | null = null;
    const emailQueueSend = vi.fn()
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValue(undefined);
    const env = makeEnv({ emailQueueSend });
    db.getOutboundRequest.mockImplementation(async () => stored);
    db.isAllowlisted.mockResolvedValue(true);
    db.insertOutboundRequest.mockImplementation(async (event, request) => {
      stored = outboundRow({
        xmtp_msg_id: event.messageId,
        from_inbox: event.senderInboxId,
        conversation_id: event.conversationId,
        to_email: JSON.stringify(request.to),
        status: 'received',
      });
      return { row: stored, inserted: true };
    });

    const first = await handleXmtpEventRequest(eventRequest('message-queue-gap', ALLOWED_INBOX), env);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      ok: true,
      accepted: true,
      queued: false,
      deferred: true,
    });
    expect(stored).toMatchObject({ status: 'received' });

    const replay = await handleXmtpEventRequest(eventRequest('message-queue-gap', ALLOWED_INBOX), env);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, deduped: true, status: 'received' });
    expect(emailQueueSend).toHaveBeenCalledTimes(2);
    expect(db.insertOutboundRequest).toHaveBeenCalledTimes(1);
    expect(db.markOutboundQueued).toHaveBeenCalledWith(env, 'message-queue-gap');
  });

  it('durably denies an unauthorized event with 2xx and continues to later messages', async () => {
    const emailQueueSend = vi.fn().mockResolvedValue(undefined);
    const xmtpQueueSend = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({ emailQueueSend, xmtpQueueSend });
    db.getOutboundRequest.mockResolvedValue(null);
    db.isAllowlisted
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    db.insertOutboundRequest.mockImplementation(async (event, request, status, error) => ({
      inserted: true,
      row: outboundRow({
        xmtp_msg_id: event.messageId,
        from_inbox: event.senderInboxId,
        conversation_id: event.conversationId,
        to_email: request ? JSON.stringify(request.to) : null,
        status,
        error,
      }),
    }));

    const denied = await handleXmtpEventRequest(eventRequest('message-denied', DENIED_INBOX), env);
    expect(denied.status).toBe(202);
    expect(await denied.json()).toMatchObject({ ok: true, accepted: true, outcome: 'denied' });
    expect(emailQueueSend).not.toHaveBeenCalled();
    expect(xmtpQueueSend).toHaveBeenCalledWith({
      version: 1,
      kind: 'xmtp_delivery',
      jobId: 'result:message-denied',
    });
    expect(db.setRelayState).toHaveBeenCalledWith(env, 'last_xmtp_message_received', {
      messageId: 'message-denied',
      senderInboxId: DENIED_INBOX,
      receivedAt: '2026-08-27T00:00:00.000Z',
    });

    const allowed = await handleXmtpEventRequest(eventRequest('message-after-denial', ALLOWED_INBOX), env);
    expect(allowed.status).toBe(202);
    expect(emailQueueSend).toHaveBeenCalledWith({
      version: 1,
      kind: 'email_delivery',
      xmtpMessageId: 'message-after-denial',
    });
  });

  it('accepts a durably recorded invalid payload so the live stream is not wedged', async () => {
    const env = makeEnv({ xmtpQueueSend: vi.fn().mockResolvedValue(undefined) });
    db.getOutboundRequest.mockResolvedValue(null);
    db.isAllowlisted.mockResolvedValue(true);
    db.insertOutboundRequest.mockImplementation(async (event, _request, status, error) => ({
      inserted: true,
      row: outboundRow({
        xmtp_msg_id: event.messageId,
        from_inbox: event.senderInboxId,
        conversation_id: event.conversationId,
        status,
        error,
      }),
    }));

    const response = await handleXmtpEventRequest(eventRequest(
      'message-invalid',
      ALLOWED_INBOX,
      JSON.stringify({ type: 'not-email.send.v1' }),
    ), env);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, outcome: 'invalid' });
  });

  it('does not let an observability write failure block durable ingestion', async () => {
    const emailQueueSend = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({ emailQueueSend });
    db.setRelayState.mockRejectedValue(new Error('relay_state unavailable'));
    db.getOutboundRequest.mockResolvedValue(null);
    db.isAllowlisted.mockResolvedValue(true);
    db.insertOutboundRequest.mockImplementation(async (event, request) => ({
      inserted: true,
      row: outboundRow({
        xmtp_msg_id: event.messageId,
        from_inbox: event.senderInboxId,
        conversation_id: event.conversationId,
        to_email: JSON.stringify(request.to),
        status: 'received',
      }),
    }));

    const response = await handleXmtpEventRequest(
      eventRequest('message-observability-gap', ALLOWED_INBOX),
      env,
    );

    expect(response.status).toBe(202);
    expect(emailQueueSend).toHaveBeenCalledOnce();
    expect(db.insertOutboundRequest).toHaveBeenCalledOnce();
  });
});

function makeEnv(overrides: {
  emailQueueSend?: ReturnType<typeof vi.fn>;
  xmtpQueueSend?: ReturnType<typeof vi.fn>;
} = {}): RelayEnv {
  return {
    CONTAINER_SHARED_SECRET: 'container-secret',
    MAX_INTERNAL_REQUEST_BYTES: String(384 * 1024),
    MAX_RELAY_BODY_BYTES: String(256 * 1024),
    EMAIL_DELIVERY_QUEUE: {
      send: overrides.emailQueueSend ?? vi.fn().mockResolvedValue(undefined),
    },
    XMTP_DELIVERY_QUEUE: {
      send: overrides.xmtpQueueSend ?? vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as RelayEnv;
}

function eventRequest(messageId: string, senderInboxId: string, content = JSON.stringify({
  type: 'email.send.v1',
  to: ['recipient@example.com'],
  subject: 'hello',
  text: 'body',
})): Request {
  return new Request('https://edge.example/internal/v1/xmtp/events', {
    method: 'POST',
    headers: {
      authorization: 'Bearer container-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messageId,
      senderInboxId,
      conversationId: `conversation:${messageId}`,
      content,
      receivedAt: '2026-08-27T00:00:00.000Z',
    }),
  });
}

function outboundRow(overrides: Partial<OutboundRow> = {}): OutboundRow {
  return {
    id: 1,
    xmtp_msg_id: 'message-1',
    from_inbox: ALLOWED_INBOX,
    conversation_id: 'conversation-1',
    to_email: JSON.stringify(['recipient@example.com']),
    cc_email: JSON.stringify([]),
    bcc_email: JSON.stringify([]),
    subject: 'hello',
    text: 'body',
    html: null,
    reply_to: null,
    status: 'received',
    provider_message_id: null,
    error: null,
    attempt_count: 0,
    result_delivered_at: null,
    created_at: '2026-08-27T00:00:00.000Z',
    updated_at: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}
