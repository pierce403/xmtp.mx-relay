import assert from 'node:assert/strict';
import test from 'node:test';
import { emailInboundV1Schema } from '../src/protocol.js';

test('inbound payload preserves UTC timestamps without rewriting precision', () => {
  const payload = {
    type: 'email.inbound.v1',
    to: 'inbox@example.com',
    from: 'sender@example.com',
    subject: 'Hello',
    text: 'Body',
    html: null,
    messageId: null,
  };
  for (const receivedAt of ['2026-11-19T15:30Z', '2026-11-19T15:30:00.123Z']) {
    assert.deepEqual(emailInboundV1Schema.parse({ ...payload, receivedAt }), { ...payload, receivedAt });
  }
  assert.equal(emailInboundV1Schema.safeParse({ ...payload, receivedAt: '2026-11-19T15:30' }).success, false);
});
