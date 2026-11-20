const assert = require('node:assert/strict');
const test = require('node:test');
const { emailSendV1Schema } = require('../dist/messages.js');

const message = { type: 'email.send.v1', to: ['recipient+tag@example.com'] };

test('legacy relay keeps email.send.v1 defaults and explicit fields', () => {
  assert.deepEqual(emailSendV1Schema.parse(message), {
    ...message, cc: [], bcc: [], subject: '', text: null, html: null, replyTo: null,
  });
  const withFields = {
    ...message, cc: ['copy@example.com'], bcc: [], subject: 'Hello', text: 'Body',
    html: null, replyTo: null,
  };
  assert.deepEqual(emailSendV1Schema.parse(withFields), withFields);
});

test('legacy relay keeps strict message validation', () => {
  for (const value of [
    { ...message, to: [] },
    { ...message, to: ['not-an-address'] },
    { ...message, extraField: true },
  ]) {
    assert.equal(emailSendV1Schema.safeParse(value).success, false);
  }
});
