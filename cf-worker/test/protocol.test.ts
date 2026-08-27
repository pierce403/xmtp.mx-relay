import { describe, expect, it } from 'vitest';
import {
  InputError,
  makeEmailSendResult,
  parseEmailSendV1,
  parseXmtpEvent,
} from '../src/protocol';

describe('wire protocol validation', () => {
  it('preserves all email.send.v1 recipient and content fields', () => {
    const parsed = parseEmailSendV1(JSON.stringify({
      type: 'email.send.v1',
      to: ['to@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      subject: 'subject',
      text: 'plain',
      html: '<p>html</p>',
      replyTo: 'reply@example.com',
    }), 64 * 1024);

    expect(parsed).toEqual({
      type: 'email.send.v1',
      to: ['to@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      subject: 'subject',
      text: 'plain',
      html: '<p>html</p>',
      replyTo: 'reply@example.com',
    });
  });

  it('rejects unknown fields and recipient/header injection', () => {
    expect(() => parseEmailSendV1(JSON.stringify({
      type: 'email.send.v1',
      to: ['victim@example.com'],
      subject: 'hello\r\nBcc: attacker@example.com',
      arbitraryRelayOption: true,
    }), 64 * 1024)).toThrow(InputError);

    expect(() => parseEmailSendV1(JSON.stringify({
      type: 'email.send.v1',
      to: ['victim@example.com\r\nBcc: attacker@example.com'],
    }), 64 * 1024)).toThrowError(/invalid email address/);
  });

  it('enforces the aggregate recipient limit', () => {
    const recipients = (prefix: string, count: number) => Array.from(
      { length: count },
      (_, index) => `${prefix}${index}@example.com`,
    );
    expect(() => parseEmailSendV1(JSON.stringify({
      type: 'email.send.v1',
      to: recipients('to', 20),
      cc: recipients('cc', 20),
      bcc: recipients('bcc', 11),
    }), 64 * 1024)).toThrowError(/must not exceed 50/);
  });

  it('requires a verified 64-hex XMTP inbox ID on Container events', () => {
    const event = {
      messageId: 'msg-1',
      senderInboxId: 'deanpierce.eth',
      conversationId: 'conversation-1',
      content: '{}',
      receivedAt: '2026-08-27T00:00:00.000Z',
    };
    expect(() => parseXmtpEvent(event, 64 * 1024)).toThrowError(/64-hex/);
    expect(parseXmtpEvent({ ...event, senderInboxId: 'A'.repeat(64) }, 64 * 1024).senderInboxId)
      .toBe('a'.repeat(64));
  });

  it('retains mailgunId as the v1 provider result field', () => {
    expect(makeEmailSendResult({ ok: true, providerMessageId: 'cloudflare-message-id' })).toEqual({
      type: 'email.send.result.v1',
      ok: true,
      mailgunId: 'cloudflare-message-id',
      error: null,
    });
  });
});
