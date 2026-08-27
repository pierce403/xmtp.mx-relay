import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayEnv } from '../src/bindings';
import type { DeliveryJobRow, OutboundRow } from '../src/db';

const containers = vi.hoisted(() => ({ getContainer: vi.fn() }));
const db = vi.hoisted(() => ({
  claimDeliveryJob: vi.fn(),
  claimOutboundRequest: vi.fn(),
  createResultDeliveryJob: vi.fn(),
  getDeliveryJob: vi.fn(),
  getOutboundRequest: vi.fn(),
  getRelayState: vi.fn(),
  markDeliveryComplete: vi.fn(),
  markDeliveryFailed: vi.fn(),
  markDeliveryQueued: vi.fn(),
  markDeliveryRetry: vi.fn(),
  markDeliveryUncertain: vi.fn(),
  markOutboundFailed: vi.fn(),
  markOutboundRetry: vi.fn(),
  markOutboundSent: vi.fn(),
  recordQueueFailure: vi.fn(),
  setRelayState: vi.fn(),
}));

vi.mock('@cloudflare/containers', () => containers);
vi.mock('../src/db', () => db);

import { handleQueueBatch, processEmailDeliveryJob, processXmtpDeliveryJob } from '../src/queues';

const SENDER_INBOX = 'a'.repeat(64);

describe('Queue delivery safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.claimDeliveryJob.mockResolvedValue(true);
    db.claimOutboundRequest.mockResolvedValue(true);
    db.getDeliveryJob.mockResolvedValue(null);
    db.getOutboundRequest.mockResolvedValue(null);
    db.getRelayState.mockResolvedValue({ paused: false });
    db.markDeliveryComplete.mockResolvedValue(undefined);
    db.markDeliveryFailed.mockResolvedValue(undefined);
    db.markDeliveryQueued.mockResolvedValue(undefined);
    db.markDeliveryRetry.mockResolvedValue(undefined);
    db.markDeliveryUncertain.mockResolvedValue(undefined);
    db.markOutboundRetry.mockResolvedValue(undefined);
    db.recordQueueFailure.mockResolvedValue(undefined);
    db.setRelayState.mockResolvedValue(undefined);
    db.createResultDeliveryJob.mockResolvedValue({
      job_id: 'result:message-1',
      status: 'received',
    });
  });

  it('never resends provider-accepted email when result Queue enqueue fails', async () => {
    let row = outboundRow({ status: 'queued' });
    const emailSend = vi.fn().mockResolvedValue({ messageId: 'cloudflare-provider-id' });
    const resultQueueSend = vi.fn()
      .mockRejectedValueOnce(new Error('result queue unavailable'))
      .mockResolvedValue(undefined);
    const env = makeEnv({ emailSend, resultQueueSend });
    db.getOutboundRequest.mockImplementation(async () => row);
    db.markOutboundSent.mockImplementation(async (_env, _id, providerMessageId) => {
      row = { ...row, status: 'sent', provider_message_id: providerMessageId };
      return row;
    });

    const first = await processEmailDeliveryJob(
      { version: 1, kind: 'email_delivery', xmtpMessageId: row.xmtp_msg_id },
      1,
      'email-delivery',
      env,
    );
    expect(first.action).toBe('retry');
    expect(row.status).toBe('sent');
    expect(emailSend).toHaveBeenCalledTimes(1);

    const reconcile = await processEmailDeliveryJob(
      { version: 1, kind: 'email_delivery', xmtpMessageId: row.xmtp_msg_id },
      2,
      'email-delivery',
      env,
    );
    expect(reconcile).toEqual({ action: 'ack' });
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(resultQueueSend).toHaveBeenCalledTimes(2);
    expect(db.markOutboundFailed).not.toHaveBeenCalled();
  });

  it('quarantines E_DELIVERY_FAILED instead of retrying an ambiguous provider outcome', async () => {
    const row = outboundRow({ status: 'queued' });
    const providerError = Object.assign(new Error('recipient delivery failed'), {
      code: 'E_DELIVERY_FAILED',
    });
    const emailSend = vi.fn().mockRejectedValue(providerError);
    const env = makeEnv({ emailSend });
    db.getOutboundRequest.mockResolvedValue(row);
    db.markOutboundFailed.mockResolvedValue({
      ...row,
      status: 'uncertain',
      error: 'delivery_state_unknown:recipient delivery failed',
    });

    const result = await processEmailDeliveryJob(
      { version: 1, kind: 'email_delivery', xmtpMessageId: row.xmtp_msg_id },
      1,
      'email-delivery',
      env,
    );

    expect(result).toEqual({ action: 'ack' });
    expect(db.markOutboundFailed).toHaveBeenCalledWith(
      env,
      row.xmtp_msg_id,
      'uncertain',
      expect.stringContaining('delivery_state_unknown:'),
    );
    expect(db.markOutboundRetry).not.toHaveBeenCalled();
  });

  it('quarantines a Container 504 instead of replaying an ambiguous XMTP send', async () => {
    const job = deliveryJob({ status: 'queued' });
    db.getDeliveryJob.mockResolvedValue(job);
    containers.getContainer.mockReturnValue({
      fetch: vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ ok: false, error: 'xmtp_delivery_timeout_ambiguous' }),
        { status: 504 },
      )),
    });

    const result = await processXmtpDeliveryJob(
      { version: 1, kind: 'xmtp_delivery', jobId: job.job_id },
      1,
      'xmtp-delivery',
      makeEnv(),
    );

    expect(result).toEqual({ action: 'ack' });
    expect(db.markDeliveryUncertain).toHaveBeenCalledWith(
      expect.anything(),
      job.job_id,
      expect.stringContaining('delivery_state_unknown:container_504'),
    );
    expect(db.markDeliveryRetry).not.toHaveBeenCalled();
    expect(db.markDeliveryComplete).not.toHaveBeenCalled();
  });

  it('retries only the Container 503 contract that is known to be pre-send', async () => {
    const job = deliveryJob({ status: 'queued' });
    db.getDeliveryJob.mockResolvedValue(job);
    containers.getContainer.mockReturnValue({
      fetch: vi.fn().mockResolvedValue(new Response('not ready', { status: 503 })),
    });

    const result = await processXmtpDeliveryJob(
      { version: 1, kind: 'xmtp_delivery', jobId: job.job_id },
      1,
      'xmtp-delivery',
      makeEnv(),
    );

    expect(result.action).toBe('retry');
    expect(db.markDeliveryRetry).toHaveBeenCalled();
    expect(db.markDeliveryUncertain).not.toHaveBeenCalled();
  });

  it('quarantines a malformed 2xx Container response instead of claiming delivery', async () => {
    const job = deliveryJob({ status: 'queued' });
    db.getDeliveryJob.mockResolvedValue(job);
    containers.getContainer.mockReturnValue({
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    });

    const result = await processXmtpDeliveryJob(
      { version: 1, kind: 'xmtp_delivery', jobId: job.job_id },
      1,
      'xmtp-delivery',
      makeEnv(),
    );

    expect(result).toEqual({ action: 'ack' });
    expect(db.markDeliveryUncertain).toHaveBeenCalledWith(
      expect.anything(),
      job.job_id,
      'delivery_state_unknown:invalid_container_success_response',
    );
    expect(db.markDeliveryComplete).not.toHaveBeenCalled();
  });

  it('does not auto-start or contact the Container while rollback pause is active', async () => {
    db.getRelayState.mockResolvedValue({ paused: true });
    const result = await processXmtpDeliveryJob(
      { version: 1, kind: 'xmtp_delivery', jobId: 'inbound:paused' },
      1,
      'xmtp-delivery',
      makeEnv(),
    );

    expect(result).toEqual({ action: 'retry', error: 'container_watchdog_paused' });
    expect(containers.getContainer).not.toHaveBeenCalled();
    expect(db.getDeliveryJob).not.toHaveBeenCalled();
  });

  it('does not auto-start or contact the Container without an explicit valid activation row', async () => {
    db.getRelayState.mockResolvedValue({ paused: 'false' });
    const result = await processXmtpDeliveryJob(
      { version: 1, kind: 'xmtp_delivery', jobId: 'inbound:not-activated' },
      1,
      'xmtp-delivery',
      makeEnv(),
    );

    expect(result).toEqual({ action: 'retry', error: 'container_activation_not_configured' });
    expect(containers.getContainer).not.toHaveBeenCalled();
    expect(db.getDeliveryJob).not.toHaveBeenCalled();
  });

  it('consumes a DLQ into durable failure visibility and acknowledges it', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      queue: 'xmtp-mx-email-delivery-dlq-production',
      messages: [{
        id: 'queue-message-id',
        timestamp: new Date(),
        attempts: 9,
        body: { version: 1, kind: 'email_delivery', xmtpMessageId: 'message-dead' },
        ack,
        retry,
      }],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<{
      version: 1;
      kind: 'email_delivery';
      xmtpMessageId: string;
    }>;

    await handleQueueBatch(batch, makeEnv());

    expect(db.recordQueueFailure).toHaveBeenCalledWith(
      expect.anything(),
      'xmtp-mx-email-delivery-dlq-production',
      'message-dead',
      9,
      'dead_lettered_after_delivery_retries',
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(db.getOutboundRequest).toHaveBeenCalledWith(expect.anything(), 'message-dead');
  });

  it('does not race an active sending row when its Queue message reaches the DLQ', async () => {
    const row = outboundRow({ status: 'sending' });
    db.getOutboundRequest.mockResolvedValue(row);
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = deadLetterBatch(
      'xmtp-mx-email-delivery-dlq-production',
      { version: 1, kind: 'email_delivery', xmtpMessageId: row.xmtp_msg_id },
      ack,
      retry,
    );

    await handleQueueBatch(batch, makeEnv());

    expect(db.markOutboundFailed).not.toHaveBeenCalled();
    expect(db.createResultDeliveryJob).not.toHaveBeenCalled();
    expect(db.recordQueueFailure).toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('does not race an active delivering job when its Queue message reaches the DLQ', async () => {
    const job = deliveryJob({ status: 'delivering' });
    db.getDeliveryJob.mockResolvedValue(job);
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = deadLetterBatch(
      'xmtp-mx-xmtp-delivery-dlq-production',
      { version: 1, kind: 'xmtp_delivery', jobId: job.job_id },
      ack,
      retry,
    );

    await handleQueueBatch(batch, makeEnv());

    expect(db.markDeliveryFailed).not.toHaveBeenCalled();
    expect(db.markDeliveryUncertain).not.toHaveBeenCalled();
    expect(db.recordQueueFailure).toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('uses the post-CAS sent row when a primary copy wins a DLQ race', async () => {
    const stale = outboundRow({ status: 'queued' });
    const sent = outboundRow({
      status: 'sent',
      provider_message_id: 'provider-won-race',
      attempt_count: 1,
    });
    db.getOutboundRequest.mockResolvedValue(stale);
    db.markOutboundFailed.mockResolvedValue(sent);
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = deadLetterBatch(
      'xmtp-mx-email-delivery-dlq-production',
      { version: 1, kind: 'email_delivery', xmtpMessageId: stale.xmtp_msg_id },
      ack,
      retry,
    );

    await handleQueueBatch(batch, makeEnv());

    expect(db.markOutboundFailed).toHaveBeenCalledWith(
      expect.anything(),
      stale.xmtp_msg_id,
      'failed',
      'dead_lettered_after_delivery_retries',
      'queued',
    );
    expect(db.createResultDeliveryJob).toHaveBeenCalledWith(
      expect.anything(),
      sent,
      expect.objectContaining({
        type: 'email.send.result.v1',
        ok: true,
        providerMessageId: 'provider-won-race',
      }),
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('defers an ordinary duplicate while outbound email is actively sending', async () => {
    const row = outboundRow({ status: 'sending' });
    db.getOutboundRequest.mockResolvedValue(row);

    const result = await processEmailDeliveryJob(
      { version: 1, kind: 'email_delivery', xmtpMessageId: row.xmtp_msg_id },
      2,
      'email-delivery',
      makeEnv(),
    );

    expect(result).toEqual({ action: 'retry', error: 'outbound_inflight_owned' });
    expect(db.markOutboundFailed).not.toHaveBeenCalled();
  });

  it('defers an ordinary duplicate while an XMTP delivery is active', async () => {
    const job = deliveryJob({ status: 'delivering' });
    db.getDeliveryJob.mockResolvedValue(job);

    const result = await processXmtpDeliveryJob(
      { version: 1, kind: 'xmtp_delivery', jobId: job.job_id },
      2,
      'xmtp-delivery',
      makeEnv(),
    );

    expect(result).toEqual({ action: 'retry', error: 'xmtp_delivery_inflight_owned' });
    expect(db.markDeliveryUncertain).not.toHaveBeenCalled();
    expect(containers.getContainer).not.toHaveBeenCalled();
  });
});

function deadLetterBatch(
  queue: string,
  body: { version: 1; kind: 'email_delivery'; xmtpMessageId: string }
    | { version: 1; kind: 'xmtp_delivery'; jobId: string },
  ack: ReturnType<typeof vi.fn>,
  retry: ReturnType<typeof vi.fn>,
): MessageBatch<never> {
  return {
    queue,
    messages: [{
      id: 'queue-message-id',
      timestamp: new Date(),
      attempts: 9,
      body,
      ack,
      retry,
    }],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<never>;
}

function makeEnv(overrides: {
  emailSend?: ReturnType<typeof vi.fn>;
  resultQueueSend?: ReturnType<typeof vi.fn>;
} = {}): RelayEnv {
  return {
    EMAIL_FROM: 'relay@xmtp.mx',
    EMAIL: { send: overrides.emailSend ?? vi.fn().mockResolvedValue({ messageId: 'provider-id' }) },
    XMTP_DELIVERY_QUEUE: {
      send: overrides.resultQueueSend ?? vi.fn().mockResolvedValue(undefined),
    },
    XMTP_RELAY: {},
    CONTAINER_SHARED_SECRET: 'container-secret',
    CONTAINER_INSTANCE_NAME: 'xmtp-mx-relay-production',
    QUEUE_MAX_RETRIES: '8',
  } as unknown as RelayEnv;
}

function outboundRow(overrides: Partial<OutboundRow> = {}): OutboundRow {
  return {
    id: 1,
    xmtp_msg_id: 'message-1',
    from_inbox: SENDER_INBOX,
    conversation_id: 'conversation-1',
    to_email: JSON.stringify(['recipient@example.com']),
    cc_email: JSON.stringify(['copy@example.com']),
    bcc_email: JSON.stringify(['blind@example.com']),
    subject: 'hello',
    text: 'plain',
    html: '<p>html</p>',
    reply_to: 'reply@example.com',
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

function deliveryJob(overrides: Partial<DeliveryJobRow> = {}): DeliveryJobRow {
  return {
    job_id: 'inbound:1',
    kind: 'email.inbound.v1',
    record_key: '1',
    conversation_id: null,
    recipient_inbox_id: null,
    sender_inbox_id: null,
    payload_json: JSON.stringify({
      type: 'email.inbound.v1',
      to: 'deanpierce.eth@xmtp.mx',
      from: 'sender@example.com',
      subject: 'hello',
      text: 'body',
      html: null,
      messageId: '<message@example.com>',
      receivedAt: '2026-08-27T00:00:00.000Z',
    }),
    status: 'received',
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
