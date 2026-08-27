import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayEnv } from '../src/bindings';

const containers = vi.hoisted(() => ({ getContainer: vi.fn() }));
const db = vi.hoisted(() => ({
  createResultDeliveryJob: vi.fn(),
  getDeliveryJob: vi.fn(),
  getOutboundRequest: vi.fn(),
  getRelayState: vi.fn(),
  getStatusSnapshot: vi.fn(),
  listAbandonedInflight: vi.fn(),
  listOrphanedBrokerWork: vi.fn(),
  listRecoverableWork: vi.fn(),
  markDeliveryQueued: vi.fn(),
  markDeliveryUncertain: vi.fn(),
  markOutboundFailed: vi.fn(),
  markOutboundQueued: vi.fn(),
  refreshDeliveryBrokerHandoff: vi.fn(),
  refreshOutboundBrokerHandoff: vi.fn(),
  recordQueueFailure: vi.fn(),
  seedConfiguredAllowlist: vi.fn(),
  setRelayState: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('@cloudflare/containers', () => ({
  ...containers,
  Container: class {
    renewActivityTimeout(): void {}
  },
  ContainerProxy: class {},
}));
vi.mock('../src/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/db')>(),
  ...db,
}));

import worker, { runWatchdog } from '../src/worker';

describe('watchdog activation interlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.seedConfiguredAllowlist.mockResolvedValue(undefined);
    db.getStatusSnapshot.mockResolvedValue({});
    db.listAbandonedInflight.mockResolvedValue({ outboundIds: [], deliveryJobIds: [] });
    db.listOrphanedBrokerWork.mockResolvedValue({ outbound: [], delivery: [] });
    db.markDeliveryQueued.mockResolvedValue(undefined);
    db.markDeliveryUncertain.mockResolvedValue(undefined);
    db.markOutboundQueued.mockResolvedValue(undefined);
    db.refreshDeliveryBrokerHandoff.mockResolvedValue(undefined);
    db.refreshOutboundBrokerHandoff.mockResolvedValue(undefined);
    db.recordQueueFailure.mockResolvedValue(undefined);
    db.setRelayState.mockResolvedValue(undefined);
  });

  it('does not start the Container when watchdog_pause is missing', async () => {
    db.getRelayState.mockResolvedValue(null);

    await runWatchdog({} as RelayEnv);

    expect(db.listRecoverableWork).not.toHaveBeenCalled();
    expect(containers.getContainer).not.toHaveBeenCalled();
    expect(db.setRelayState).toHaveBeenCalledWith(
      expect.anything(),
      'container_watchdog',
      expect.objectContaining({
        ok: false,
        configured: false,
        paused: null,
        activationRequired: true,
      }),
    );
  });

  it('does not start the Container when watchdog_pause has an invalid shape', async () => {
    db.getRelayState.mockResolvedValue({ paused: 'false' });

    await runWatchdog({} as RelayEnv);

    expect(db.listRecoverableWork).not.toHaveBeenCalled();
    expect(containers.getContainer).not.toHaveBeenCalled();
    expect(db.setRelayState).toHaveBeenCalledWith(
      expect.anything(),
      'container_watchdog',
      expect.objectContaining({ configured: false, paused: null, activationRequired: true }),
    );
  });

  it('reports a missing activation row honestly instead of paused false', async () => {
    db.getRelayState.mockResolvedValue(null);
    const relay = {
      getState: vi.fn().mockResolvedValue({ status: 'stopped' }),
      fetch: vi.fn(),
    };
    containers.getContainer.mockReturnValue(relay);

    const response = await worker.fetch(new Request('https://edge.example/internal/v1/status', {
      headers: { authorization: 'Bearer admin-secret' },
    }), {
      RELAY_ADMIN_TOKEN: 'admin-secret',
      CONTAINER_INSTANCE_NAME: 'xmtp-mx-relay-production',
      XMTP_ENV: 'production',
      XMTP_RELAY: {},
    } as unknown as RelayEnv);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      container: {
        watchdogConfigured: false,
        watchdogPaused: null,
      },
    });
    expect(relay.fetch).not.toHaveBeenCalled();
  });

  it('reconstructs a missing terminal email.send.result.v1 outbox job', async () => {
    db.getRelayState.mockResolvedValue({ paused: false });
    db.listRecoverableWork.mockResolvedValue({
      inboundIds: [],
      outboundIds: [],
      outboundResultIds: ['message-sent'],
      deliveryJobIds: [],
    });
    db.getOutboundRequest.mockResolvedValue({
      id: 1,
      xmtp_msg_id: 'message-sent',
      from_inbox: 'a'.repeat(64),
      conversation_id: 'conversation-1',
      to_email: '["recipient@example.com"]',
      cc_email: '[]',
      bcc_email: '[]',
      subject: 'hello',
      text: 'body',
      html: null,
      reply_to: null,
      status: 'sent',
      provider_message_id: 'provider-message-id',
      error: null,
      attempt_count: 1,
      result_delivered_at: null,
      created_at: '2026-08-27T00:00:00.000Z',
      updated_at: '2026-08-27T00:00:00.000Z',
    });
    db.createResultDeliveryJob.mockResolvedValue({
      job_id: 'result:message-sent',
      status: 'received',
    });
    const relay = {
      getState: vi.fn().mockResolvedValue({ status: 'healthy' }),
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, ready: true }), {
        status: 200,
      })),
    };
    containers.getContainer.mockReturnValue(relay);
    const xmtpQueueSend = vi.fn().mockResolvedValue(undefined);
    const env = {
      CONTAINER_INSTANCE_NAME: 'xmtp-mx-relay-production',
      XMTP_ENV: 'production',
      XMTP_RELAY: {},
      EMAIL_DELIVERY_QUEUE: { send: vi.fn() },
      XMTP_DELIVERY_QUEUE: { send: xmtpQueueSend },
    } as unknown as RelayEnv;

    await runWatchdog(env);

    expect(db.createResultDeliveryJob).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ xmtp_msg_id: 'message-sent', status: 'sent' }),
      expect.objectContaining({ type: 'email.send.result.v1', ok: true }),
    );
    expect(xmtpQueueSend).toHaveBeenCalledWith({
      version: 1,
      kind: 'xmtp_delivery',
      jobId: 'result:message-sent',
    });
    expect(db.markDeliveryQueued).toHaveBeenCalledWith(env, 'result:message-sent');
  });

  it('restarts the Container even when an independent Queue repair fails', async () => {
    db.getRelayState.mockResolvedValue({ paused: false });
    db.listRecoverableWork.mockResolvedValue({
      inboundIds: [],
      outboundIds: ['message-queue-gap'],
      outboundResultIds: [],
      deliveryJobIds: [],
    });
    const relay = {
      getState: vi.fn()
        .mockResolvedValueOnce({ status: 'stopped' })
        .mockResolvedValueOnce({ status: 'healthy' }),
      startAndWaitForPorts: vi.fn().mockResolvedValue(undefined),
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, ready: true }), {
        status: 200,
      })),
    };
    containers.getContainer.mockReturnValue(relay);
    const env = {
      CONTAINER_INSTANCE_NAME: 'xmtp-mx-relay-production',
      XMTP_ENV: 'production',
      XMTP_RELAY: {},
      EMAIL_DELIVERY_QUEUE: { send: vi.fn().mockRejectedValue(new Error('queue unavailable')) },
      XMTP_DELIVERY_QUEUE: { send: vi.fn() },
    } as unknown as RelayEnv;

    await expect(runWatchdog(env)).resolves.toBeUndefined();

    expect(relay.startAndWaitForPorts).toHaveBeenCalledOnce();
    expect(relay.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://container/readyz' }));
    expect(db.setRelayState).toHaveBeenCalledWith(
      env,
      'container_watchdog',
      expect.objectContaining({ ok: true }),
    );
  });

  it('quarantines a long-abandoned sending row without invoking Email Service again', async () => {
    db.getRelayState.mockResolvedValue({ paused: false });
    db.listRecoverableWork.mockResolvedValue({
      inboundIds: [],
      outboundIds: [],
      outboundResultIds: [],
      deliveryJobIds: [],
    });
    db.listAbandonedInflight.mockResolvedValue({
      outboundIds: ['message-abandoned'],
      deliveryJobIds: [],
    });
    const sending = {
      id: 1,
      xmtp_msg_id: 'message-abandoned',
      from_inbox: 'a'.repeat(64),
      conversation_id: 'conversation-1',
      status: 'sending',
      attempt_count: 3,
      result_delivered_at: null,
    };
    const uncertain = {
      ...sending,
      status: 'uncertain',
      error: 'delivery_state_unknown_after_abandoned_inflight',
    };
    db.getOutboundRequest.mockResolvedValue(sending);
    db.markOutboundFailed.mockResolvedValue(uncertain);
    db.createResultDeliveryJob.mockResolvedValue({
      job_id: 'result:message-abandoned',
      status: 'received',
    });
    const relay = {
      getState: vi.fn().mockResolvedValue({ status: 'healthy' }),
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, ready: true }), {
        status: 200,
      })),
    };
    containers.getContainer.mockReturnValue(relay);
    const xmtpQueueSend = vi.fn().mockResolvedValue(undefined);
    const emailQueueSend = vi.fn();
    const env = {
      CONTAINER_INSTANCE_NAME: 'xmtp-mx-relay-production',
      XMTP_ENV: 'production',
      XMTP_RELAY: {},
      EMAIL_DELIVERY_QUEUE: { send: emailQueueSend },
      XMTP_DELIVERY_QUEUE: { send: xmtpQueueSend },
      QUEUE_ABANDONED_SECONDS: '21600',
    } as unknown as RelayEnv;

    await runWatchdog(env);

    expect(db.markOutboundFailed).toHaveBeenCalledWith(
      env,
      'message-abandoned',
      'uncertain',
      'delivery_state_unknown_after_abandoned_inflight',
      'sending',
    );
    expect(db.recordQueueFailure).toHaveBeenCalledWith(
      env,
      'watchdog-abandoned-email-delivery',
      'message-abandoned',
      3,
      'delivery_state_unknown_after_abandoned_inflight',
    );
    expect(xmtpQueueSend).toHaveBeenCalledWith({
      version: 1,
      kind: 'xmtp_delivery',
      jobId: 'result:message-abandoned',
    });
    expect(emailQueueSend).not.toHaveBeenCalled();
  });

  it('republishes a day-old safe broker handoff and refreshes only after Queue accepts it', async () => {
    db.getRelayState.mockResolvedValue({ paused: false });
    db.listRecoverableWork.mockResolvedValue({
      inboundIds: [],
      outboundIds: [],
      outboundResultIds: [],
      deliveryJobIds: [],
    });
    db.listOrphanedBrokerWork.mockResolvedValue({
      outbound: [{ xmtpMessageId: 'message-orphaned', status: 'retrying' }],
      delivery: [{ jobId: 'inbound:orphaned', status: 'queued' }],
    });
    const relay = {
      getState: vi.fn().mockResolvedValue({ status: 'healthy' }),
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, ready: true }), {
        status: 200,
      })),
    };
    containers.getContainer.mockReturnValue(relay);
    const emailQueueSend = vi.fn().mockResolvedValue(undefined);
    const xmtpQueueSend = vi.fn().mockResolvedValue(undefined);
    const env = {
      CONTAINER_INSTANCE_NAME: 'xmtp-mx-relay-production',
      XMTP_ENV: 'production',
      XMTP_RELAY: {},
      EMAIL_DELIVERY_QUEUE: { send: emailQueueSend },
      XMTP_DELIVERY_QUEUE: { send: xmtpQueueSend },
      QUEUE_ORPHANED_HANDOFF_SECONDS: '86400',
    } as unknown as RelayEnv;

    await runWatchdog(env);

    expect(emailQueueSend).toHaveBeenCalledWith({
      version: 1,
      kind: 'email_delivery',
      xmtpMessageId: 'message-orphaned',
    });
    expect(db.refreshOutboundBrokerHandoff).toHaveBeenCalledWith(
      env,
      'message-orphaned',
      'retrying',
    );
    expect(xmtpQueueSend).toHaveBeenCalledWith({
      version: 1,
      kind: 'xmtp_delivery',
      jobId: 'inbound:orphaned',
    });
    expect(db.refreshDeliveryBrokerHandoff).toHaveBeenCalledWith(
      env,
      'inbound:orphaned',
      'queued',
    );
    expect(emailQueueSend.mock.invocationCallOrder[0]).toBeLessThan(
      db.refreshOutboundBrokerHandoff.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(xmtpQueueSend.mock.invocationCallOrder[0]).toBeLessThan(
      db.refreshDeliveryBrokerHandoff.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
