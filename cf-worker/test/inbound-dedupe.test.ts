import { describe, expect, it } from 'vitest';
import { computeInboundDedupeKey, serializedInboundPayloadBytes } from '../src/inbound';

describe('inbound replay deduplication', () => {
  it('collapses an exact Cloudflare replay', async () => {
    const raw = new TextEncoder().encode(
      'Message-ID: <sender-controlled@example.com>\r\nSubject: hello\r\n\r\nbody',
    ).buffer as ArrayBuffer;
    const first = await computeInboundDedupeKey('Sender@Example.com', 'DeanPierce.Eth@XMTP.MX', raw);
    const replay = await computeInboundDedupeKey(' sender@example.com ', 'deanpierce.eth@xmtp.mx', raw);
    expect(replay).toBe(first);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('does not collapse different content that reuses a spoofed Message-ID', async () => {
    const raw = (body: string) => new TextEncoder().encode(
      `Message-ID: <same@example.com>\r\nSubject: hello\r\n\r\n${body}`,
    ).buffer as ArrayBuffer;
    const first = await computeInboundDedupeKey(
      'sender@example.com',
      'deanpierce.eth@xmtp.mx',
      raw('first'),
    );
    const second = await computeInboundDedupeKey(
      'sender@example.com',
      'deanpierce.eth@xmtp.mx',
      raw('second'),
    );
    expect(second).not.toBe(first);
  });

  it('accounts for wire metadata and JSON escaping in the XMTP payload limit', () => {
    const escapedBody = '\\'.repeat(100);
    const bytes = serializedInboundPayloadBytes({
      type: 'email.inbound.v1',
      to: 'deanpierce.eth@xmtp.mx',
      from: 'sender@example.com',
      subject: 'subject',
      text: escapedBody,
      html: null,
      messageId: '<message@example.com>',
      receivedAt: '2026-08-27T00:00:00.000Z',
    });
    expect(bytes).toBeGreaterThan(new TextEncoder().encode(escapedBody).byteLength + 100);
  });
});
