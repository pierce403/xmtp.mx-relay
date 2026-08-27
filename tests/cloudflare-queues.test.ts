import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  outbound: null as Record<string, any> | null,
  delivery: null as Record<string, any> | null,
  containerFetch: vi.fn(),
  getRelayState: vi.fn(),
  claimOutboundRequest: vi.fn(),
  claimDeliveryJob: vi.fn(),
  createResultDeliveryJob: vi.fn(),
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

vi.mock('../cf-worker/src/db', () => ({
  getOutboundRequest: vi.fn(async () => state.outbound),
  getDeliveryJob: vi.fn(async () => state.delivery),
  getRelayState: state.getRelayState,
  claimOutboundRequest: state.claimOutboundRequest,
  claimDeliveryJob: state.claimDeliveryJob,
  createResultDeliveryJob: state.createResultDeliveryJob,
  markDeliveryComplete: state.markDeliveryComplete,
  markDeliveryFailed: state.markDeliveryFailed,
  markDeliveryQueued: state.markDeliveryQueued,
  markDeliveryRetry: state.markDeliveryRetry,
  markDeliveryUncertain: state.markDeliveryUncertain,
  markOutboundFailed: state.markOutboundFailed,
  markOutboundRetry: state.markOutboundRetry,
  markOutboundSent: state.markOutboundSent,
  recordQueueFailure: state.recordQueueFailure,
  setRelayState: state.setRelayState,
}));

import { processEmailDeliveryJob, processXmtpDeliveryJob } from '../cf-worker/src/queues';
import type { RelayEnv } from '../cf-worker/src/bindings';
import { setTestContainerFetcher } from './stubs/cloudflare-containers';

const outboundRow = {
  id: 1,
  xmtp_msg_id: 'xmtp-message-id',
  from_inbox: 'sender-inbox',
  conversation_id: 'conversation-id',
  to_email: '["to@example.com"]',
  cc_email: '["cc@example.com"]',
  bcc_email: '["bcc@example.com"]',
  subject: 'subject',
  text: 'plain',
  html: '<p>html</p>',
  reply_to: 'reply@example.com',
  status: 'queued',
  provider_message_id: null,
  error: null,
  attempt_count: 0,
  result_delivered_at: null,
  created_at: '2026-08-27T00:00:00.000Z',
  updated_at: '2026-08-27T00:00:00.000Z',
};

const deliveryRow = {
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
    subject: 'subject',
    text: 'text',
    html: null,
    messageId: '<message@example.com>',
    receivedAt: '2026-08-27T00:00:00.000Z',
  }),
  status: 'queued',
  attempt_count: 0,
  last_error: null,
  queued_at: '2026-08-27T00:00:00.000Z',
  delivered_at: null,
  xmtp_message_id: null,
  created_at: '2026-08-27T00:00:00.000Z',
  updated_at: '2026-08-27T00:00:00.000Z',
};

let emailSend: ReturnType<typeof vi.fn>;
let xmtpQueueSend: ReturnType<typeof vi.fn>;
let env: RelayEnv;

beforeEach(() => {
  vi.clearAllMocks();
  state.outbound = { ...outboundRow };
  state.delivery = { ...deliveryRow };
  state.claimOutboundRequest.mockResolvedValue(true);
  state.claimDeliveryJob.mockResolvedValue(true);
  state.getRelayState.mockResolvedValue({ paused: false });
  state.markOutboundSent.mockImplementation(async (_env, _id, providerMessageId) => ({
    ...outboundRow,
    status: 'sent',
    provider_message_id: providerMessageId,
  }));
  state.markOutboundFailed.mockImplementation(async (_env, _id, status, error) => ({
    ...outboundRow,
    status,
    error,
  }));
  state.createResultDeliveryJob.mockResolvedValue({
    ...deliveryRow,
    job_id: 'result:xmtp-message-id',
    kind: 'email.send.result.v1',
    status: 'received',
  });
  state.markDeliveryComplete.mockImplementation(async (_env, row, xmtpMessageId) => ({
    ...row,
    status: 'delivered',
    xmtp_message_id: xmtpMessageId,
  }));
  emailSend = vi.fn();
  xmtpQueueSend = vi.fn().mockResolvedValue(undefined);
  setTestContainerFetcher((request) => state.containerFetch(request));
  env = {
    EMAIL_FROM: 'Dean (XMTP) <deanpierce.eth@xmtp.mx>',
    EMAIL: { send: emailSend },
    XMTP_DELIVERY_QUEUE: { send: xmtpQueueSend },
    XMTP_RELAY: {} as DurableObjectNamespace,
    CONTAINER_SHARED_SECRET: 'container-secret',
    QUEUE_MAX_RETRIES: '5',
  } as RelayEnv;
});

describe('outbound Cloudflare Email Service retries (B/E/H)', () => {
  it('preserves all email fields and stores the provider ID on success', async () => {
    emailSend.mockResolvedValue({ messageId: 'cloudflare-provider-id' });

    const action = await processEmailDeliveryJob(
      { version: 1, kind: 'email_delivery', xmtpMessageId: 'xmtp-message-id' },
      1,
      'xmtp-mx-email-delivery',
      env,
    );

    expect(action).toEqual({ action: 'ack' });
    expect(emailSend).toHaveBeenCalledOnce();
    expect(emailSend).toHaveBeenCalledWith({
      from: { name: 'Dean (XMTP)', email: 'deanpierce.eth@xmtp.mx' },
      to: ['to@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      subject: 'subject',
      text: 'plain',
      html: '<p>html</p>',
      replyTo: 'reply@example.com',
      headers: { 'X-XMTP-Relay-Key': 'xmtp-message-id' },
    });
    expect(state.markOutboundSent).toHaveBeenCalledWith(env, 'xmtp-message-id', 'cloudflare-provider-id');
    expect(xmtpQueueSend).toHaveBeenCalledWith({
      version: 1,
      kind: 'xmtp_delivery',
      jobId: 'result:xmtp-message-id',
    });
  });

  it('retries a documented transient provider failure', async () => {
    emailSend.mockRejectedValue(Object.assign(new Error('try later'), { code: 'E_RATE_LIMIT_EXCEEDED' }));

    const action = await processEmailDeliveryJob(
      { version: 1, kind: 'email_delivery', xmtpMessageId: 'xmtp-message-id' },
      1,
      'xmtp-mx-email-delivery',
      env,
    );

    expect(action).toEqual({ action: 'retry', error: 'try later' });
    expect(state.markOutboundRetry).toHaveBeenCalledWith(
      env,
      'xmtp-message-id',
      'E_RATE_LIMIT_EXCEEDED:try later',
    );
    expect(state.markOutboundSent).not.toHaveBeenCalled();
  });

  it('records a final transient failure for dead-letter visibility', async () => {
    emailSend.mockRejectedValue(Object.assign(new Error('still down'), { code: 'E_INTERNAL_SERVER_ERROR' }));

    const action = await processEmailDeliveryJob(
      { version: 1, kind: 'email_delivery', xmtpMessageId: 'xmtp-message-id' },
      6,
      'xmtp-mx-email-delivery',
      env,
    );

    expect(action.action).toBe('retry');
    expect(state.recordQueueFailure).toHaveBeenCalledWith(
      env,
      'xmtp-mx-email-delivery',
      'xmtp-message-id',
      6,
      'still down',
    );
    expect(xmtpQueueSend).toHaveBeenCalledOnce();
  });

  it('quarantines an ambiguous provider exception instead of risking duplicate email', async () => {
    emailSend.mockRejectedValue(new Error('connection closed after request body'));

    const action = await processEmailDeliveryJob(
      { version: 1, kind: 'email_delivery', xmtpMessageId: 'xmtp-message-id' },
      1,
      'xmtp-mx-email-delivery',
      env,
    );

    expect(action).toEqual({ action: 'ack' });
    expect(state.markOutboundFailed).toHaveBeenCalledWith(
      env,
      'xmtp-message-id',
      'uncertain',
      expect.stringContaining('delivery_state_unknown:'),
    );
    expect(state.markOutboundRetry).not.toHaveBeenCalled();
  });

  it('does not call Email Service again for a replayed sent request', async () => {
    state.outbound = { ...outboundRow, status: 'sent', provider_message_id: 'existing-provider-id' };

    const action = await processEmailDeliveryJob(
      { version: 1, kind: 'email_delivery', xmtpMessageId: 'xmtp-message-id' },
      2,
      'xmtp-mx-email-delivery',
      env,
    );

    expect(action).toEqual({ action: 'ack' });
    expect(emailSend).not.toHaveBeenCalled();
    expect(state.claimOutboundRequest).not.toHaveBeenCalled();
    expect(xmtpQueueSend).toHaveBeenCalledOnce();
  });

  it('defers a request whose in-flight owner may still be active', async () => {
    state.outbound = { ...outboundRow, status: 'sending' };

    const action = await processEmailDeliveryJob(
      { version: 1, kind: 'email_delivery', xmtpMessageId: 'xmtp-message-id' },
      2,
      'xmtp-mx-email-delivery',
      env,
    );

    expect(action).toEqual({ action: 'retry', error: 'outbound_inflight_owned' });
    expect(emailSend).not.toHaveBeenCalled();
    expect(state.markOutboundFailed).not.toHaveBeenCalled();
  });
});

describe('XMTP Container retries and ambiguous delivery safety (A/D/H)', () => {
  it('fails closed without an explicit watchdog activation state', async () => {
    state.getRelayState.mockResolvedValue(null);

    const action = await processXmtpDeliveryJob(
      { version: 1, kind: 'xmtp_delivery', jobId: 'inbound:1' },
      1,
      'xmtp-mx-xmtp-delivery',
      env,
    );

    expect(action).toEqual({ action: 'retry', error: 'container_activation_not_configured' });
    expect(state.containerFetch).not.toHaveBeenCalled();
    expect(state.claimDeliveryJob).not.toHaveBeenCalled();
  });

  it('retries without touching the Container while the watchdog is paused', async () => {
    state.getRelayState.mockResolvedValue({ paused: true });

    const action = await processXmtpDeliveryJob(
      { version: 1, kind: 'xmtp_delivery', jobId: 'inbound:1' },
      1,
      'xmtp-mx-xmtp-delivery',
      env,
    );

    expect(action).toEqual({ action: 'retry', error: 'container_watchdog_paused' });
    expect(state.containerFetch).not.toHaveBeenCalled();
    expect(state.claimDeliveryJob).not.toHaveBeenCalled();
  });

  it('retries a definite Container 503 response', async () => {
    state.containerFetch.mockResolvedValue(new Response('not ready', { status: 503 }));

    const action = await processXmtpDeliveryJob(
      { version: 1, kind: 'xmtp_delivery', jobId: 'inbound:1' },
      1,
      'xmtp-mx-xmtp-delivery',
      env,
    );

    expect(action).toEqual({ action: 'retry', error: 'container_503:not ready' });
    expect(state.markDeliveryRetry).toHaveBeenCalledWith(env, 'inbound:1', 'container_503:not ready');
    expect(state.markDeliveryComplete).not.toHaveBeenCalled();
  });

  it('marks one successful Container delivery complete', async () => {
    state.containerFetch.mockResolvedValue(Response.json({ ok: true, messageId: 'xmtp-delivery-id' }));

    const action = await processXmtpDeliveryJob(
      { version: 1, kind: 'xmtp_delivery', jobId: 'inbound:1' },
      2,
      'xmtp-mx-xmtp-delivery',
      env,
    );

    expect(action).toEqual({ action: 'ack' });
    expect(state.markDeliveryComplete).toHaveBeenCalledWith(env, state.delivery, 'xmtp-delivery-id');
  });

  it('quarantines an ambiguous transport exception rather than duplicating XMTP mail', async () => {
    state.containerFetch.mockRejectedValue(new Error('connection reset after accept'));

    const action = await processXmtpDeliveryJob(
      { version: 1, kind: 'xmtp_delivery', jobId: 'inbound:1' },
      1,
      'xmtp-mx-xmtp-delivery',
      env,
    );

    expect(action).toEqual({ action: 'ack' });
    expect(state.markDeliveryUncertain).toHaveBeenCalledWith(
      env,
      'inbound:1',
      'delivery_state_unknown:connection reset after accept',
    );
    expect(state.markDeliveryRetry).not.toHaveBeenCalled();
  });

  it('does not call the Container again for a replayed delivered job', async () => {
    state.delivery = { ...deliveryRow, status: 'delivered', xmtp_message_id: 'existing-xmtp-id' };

    const action = await processXmtpDeliveryJob(
      { version: 1, kind: 'xmtp_delivery', jobId: 'inbound:1' },
      2,
      'xmtp-mx-xmtp-delivery',
      env,
    );

    expect(action).toEqual({ action: 'ack' });
    expect(state.containerFetch).not.toHaveBeenCalled();
    expect(state.claimDeliveryJob).not.toHaveBeenCalled();
  });
});
