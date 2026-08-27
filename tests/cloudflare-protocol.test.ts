import { describe, expect, it } from 'vitest';
import {
  InputError,
  makeEmailSendResult,
  parseEmailSendV1,
  parseXmtpEvent,
} from '../cf-worker/src/protocol';

describe('email.send.v1 compatibility and validation', () => {
  it('preserves every v1 delivery field', () => {
    const request = {
      type: 'email.send.v1',
      to: ['to@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      subject: 'subject',
      text: 'plain',
      html: '<p>html</p>',
      replyTo: 'reply@example.com',
    };

    expect(parseEmailSendV1(JSON.stringify(request), 100_000)).toEqual(request);
  });

  it('retains safe v1 defaults', () => {
    expect(parseEmailSendV1(JSON.stringify({ type: 'email.send.v1', to: ['to@example.com'] }), 10_000)).toEqual({
      type: 'email.send.v1',
      to: ['to@example.com'],
      cc: [],
      bcc: [],
      subject: '',
      text: null,
      html: null,
      replyTo: null,
    });
  });

  it.each([
    [{ type: 'email.send.v1', to: [] }, 'invalid_payload'],
    [{ type: 'email.send.v1', to: ['not-an-email'] }, 'invalid_recipient'],
    [{ type: 'email.send.v1', to: ['a@example.com\r\nBcc: victim@example.com'] }, 'invalid_recipient'],
    [{ type: 'email.send.v1', to: ['a@example.com'], subject: 'ok\nBcc: victim@example.com' }, 'invalid_payload'],
    [{ type: 'email.send.v1', to: ['a@example.com'], from: 'attacker@example.com' }, 'invalid_payload'],
    [{ type: 'email.send.v2', to: ['a@example.com'] }, 'invalid_payload'],
  ])('rejects unsafe or relay-expanding payload %#', (payload, expectedCode) => {
    try {
      parseEmailSendV1(JSON.stringify(payload), 100_000);
      throw new Error('expected parser to reject payload');
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      expect((error as InputError).code).toBe(expectedCode);
    }
  });

  it('enforces the byte limit before parsing', () => {
    const payload = JSON.stringify({
      type: 'email.send.v1',
      to: ['to@example.com'],
      text: 'é'.repeat(100),
    });
    expect(() => parseEmailSendV1(payload, 100)).toThrowError(/size limit/);
  });
});

describe('Worker/Container event contract', () => {
  const event = {
    messageId: 'xmtp-message-id',
    senderInboxId: 'AB'.repeat(32),
    conversationId: 'conversation-id',
    content: '{"type":"email.send.v1"}',
    receivedAt: '2026-08-27T00:00:00.000Z',
  };

  it('normalizes sender inbox IDs for allowlist checks', () => {
    expect(parseXmtpEvent(event, 10_000)).toEqual({ ...event, senderInboxId: 'ab'.repeat(32) });
  });

  it.each([
    [{ ...event, receivedAt: 'not-a-date' }, 'invalid_event'],
    [{ ...event, messageId: '' }, 'invalid_event'],
    [{ ...event, unexpected: true }, 'invalid_event'],
    [{ ...event, content: 'x'.repeat(101) }, 'payload_too_large'],
  ])('rejects malformed private events %#', (value, expectedCode) => {
    try {
      parseXmtpEvent(value, 100);
      throw new Error('expected parser to reject event');
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      expect((error as InputError).code).toBe(expectedCode);
    }
  });
});

describe('email.send.result.v1 compatibility', () => {
  it('retains mailgunId as the provider-neutral v1 compatibility field', () => {
    expect(makeEmailSendResult({ ok: true, providerMessageId: 'cloudflare-message-id' })).toEqual({
      type: 'email.send.result.v1',
      ok: true,
      mailgunId: 'cloudflare-message-id',
      error: null,
    });
  });
});
