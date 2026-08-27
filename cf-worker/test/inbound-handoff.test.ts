import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayEnv } from '../src/bindings';

const postal = vi.hoisted(() => ({ parse: vi.fn() }));
const db = vi.hoisted(() => ({
  createInboundDeliveryJob: vi.fn(),
  getRelayState: vi.fn(),
  insertInboundEmail: vi.fn(),
  markDeliveryQueued: vi.fn(),
  resolveThreadId: vi.fn(),
  setRelayState: vi.fn(),
}));

vi.mock('postal-mime', () => ({ default: { parse: postal.parse } }));
vi.mock('../src/db', () => db);

import { handleInboundEmail } from '../src/inbound';

describe('inbound durable handoff boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postal.parse.mockResolvedValue({
      text: 'body',
      html: null,
      messageId: '<message@example.com>',
      inReplyTo: null,
      subject: 'hello',
    });
    db.resolveThreadId.mockResolvedValue('<message@example.com>');
    db.insertInboundEmail.mockResolvedValue({
      inserted: true,
      row: { id: 7, status: 'received' },
    });
    db.createInboundDeliveryJob.mockResolvedValue({
      job_id: 'inbound:7',
      status: 'received',
    });
    db.markDeliveryQueued.mockResolvedValue(undefined);
    db.setRelayState.mockResolvedValue(undefined);
    db.getRelayState.mockResolvedValue({
      paused: false,
      at: '2026-08-27T00:00:00.000Z',
      reason: 'operator_start',
    });
  });

  it('acknowledges SMTP after the source row commits when Queue handoff is unavailable', async () => {
    const queueSend = vi.fn().mockRejectedValue(new Error('queue unavailable'));
    const message = inboundMessage();

    await expect(handleInboundEmail(message, makeEnv(queueSend))).resolves.toBeUndefined();

    expect(db.insertInboundEmail).toHaveBeenCalledOnce();
    expect(queueSend).toHaveBeenCalledWith({
      version: 1,
      kind: 'xmtp_delivery',
      jobId: 'inbound:7',
    });
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('leaves SMTP unacknowledged when no durable source row was confirmed', async () => {
    db.insertInboundEmail.mockRejectedValue(new Error('D1 unavailable'));

    await expect(handleInboundEmail(inboundMessage(), makeEnv(vi.fn())))
      .rejects.toThrow('D1 unavailable');
  });

  it('holds durable inbound work without spending Queue retries while XMTP is paused', async () => {
    db.getRelayState.mockResolvedValue({
      paused: true,
      at: '2026-08-27T00:00:00.000Z',
      reason: 'pre_mx_deploy',
    });
    const queueSend = vi.fn();
    const message = inboundMessage();

    await expect(handleInboundEmail(message, makeEnv(queueSend))).resolves.toBeUndefined();

    expect(db.insertInboundEmail).toHaveBeenCalledOnce();
    expect(db.createInboundDeliveryJob).toHaveBeenCalledOnce();
    expect(queueSend).not.toHaveBeenCalled();
    expect(db.markDeliveryQueued).not.toHaveBeenCalled();
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('holds durable inbound work when the activation record is missing or invalid', async () => {
    db.getRelayState.mockResolvedValue(null);
    const queueSend = vi.fn();

    await expect(handleInboundEmail(inboundMessage(), makeEnv(queueSend))).resolves.toBeUndefined();

    expect(queueSend).not.toHaveBeenCalled();
    expect(db.markDeliveryQueued).not.toHaveBeenCalled();
  });

  it('accepts the deanpierce alias and publishes it to the same XMTP delivery path', async () => {
    const queueSend = vi.fn();
    const message = inboundMessage('deanpierce@xmtp.mx');

    await expect(handleInboundEmail(message, makeEnv(queueSend))).resolves.toBeUndefined();

    expect(queueSend).toHaveBeenCalledWith({
      version: 1,
      kind: 'xmtp_delivery',
      jobId: 'inbound:7',
    });
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('rejects recipients outside the two explicit production addresses', async () => {
    const queueSend = vi.fn();
    const message = inboundMessage('not-dean@xmtp.mx');

    await expect(handleInboundEmail(message, makeEnv(queueSend))).resolves.toBeUndefined();

    expect(message.setReject).toHaveBeenCalledWith('Recipient is not configured for this relay');
    expect(db.insertInboundEmail).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
  });
});

function makeEnv(queueSend: ReturnType<typeof vi.fn>): RelayEnv {
  return {
    INBOUND_EMAIL_TO: 'deanpierce.eth@xmtp.mx,deanpierce@xmtp.mx',
    MAX_INBOUND_EMAIL_BYTES: String(5 * 1024 * 1024),
    MAX_RELAY_BODY_BYTES: String(256 * 1024),
    XMTP_DELIVERY_QUEUE: { send: queueSend },
  } as unknown as RelayEnv;
}

function inboundMessage(
  to = 'deanpierce.eth@xmtp.mx',
): ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn> } {
  const raw = new TextEncoder().encode(
    `From: sender@example.com\r\nTo: ${to}\r\nSubject: hello\r\n\r\nbody`,
  );
  const setReject = vi.fn();
  return {
    from: 'sender@example.com',
    to,
    rawSize: raw.byteLength,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(raw);
        controller.close();
      },
    }),
    headers: new Headers({
      from: 'sender@example.com',
      to,
      subject: 'hello',
      'message-id': '<message@example.com>',
    }),
    setReject,
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn> };
}
