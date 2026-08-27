import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayEnv } from '../src/bindings';

const postal = vi.hoisted(() => ({ parse: vi.fn() }));
const db = vi.hoisted(() => ({
  createInboundDeliveryJob: vi.fn(),
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
});

function makeEnv(queueSend: ReturnType<typeof vi.fn>): RelayEnv {
  return {
    INBOUND_EMAIL_TO: 'deanpierce.eth@xmtp.mx',
    MAX_INBOUND_EMAIL_BYTES: String(5 * 1024 * 1024),
    MAX_RELAY_BODY_BYTES: String(256 * 1024),
    XMTP_DELIVERY_QUEUE: { send: queueSend },
  } as unknown as RelayEnv;
}

function inboundMessage(): ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn> } {
  const raw = new TextEncoder().encode(
    'From: sender@example.com\r\nTo: deanpierce.eth@xmtp.mx\r\nSubject: hello\r\n\r\nbody',
  );
  const setReject = vi.fn();
  return {
    from: 'sender@example.com',
    to: 'deanpierce.eth@xmtp.mx',
    rawSize: raw.byteLength,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(raw);
        controller.close();
      },
    }),
    headers: new Headers({
      from: 'sender@example.com',
      to: 'deanpierce.eth@xmtp.mx',
      subject: 'hello',
      'message-id': '<message@example.com>',
    }),
    setReject,
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn> };
}
