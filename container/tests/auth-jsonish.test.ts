import assert from 'node:assert/strict';
import test from 'node:test';
import { isAuthorized } from '../src/auth.js';
import { canonicalizeEmailSendEventContent } from '../src/jsonish.js';

test('Bearer authentication rejects missing or different credentials', () => {
  const secret = 'correct-secret-value-with-32-bytes';
  assert.equal(isAuthorized(undefined, secret), false);
  assert.equal(isAuthorized('Basic abc', secret), false);
  assert.equal(isAuthorized('Bearer wrong', secret), false);
  assert.equal(isAuthorized(`Bearer ${secret}`, secret), true);
});

test('legacy fenced email.send.v1 becomes strict canonical JSON for the edge', () => {
  const fenced = [
    'Here is the request:',
    '```json',
    '{"type":"email.send.v1","to":["recipient@example.com"],"text":"hello"}',
    '```',
  ].join('\n');
  const canonical = canonicalizeEmailSendEventContent(fenced);
  assert.ok(canonical);
  assert.deepEqual(JSON.parse(canonical), {
    type: 'email.send.v1',
    to: ['recipient@example.com'],
    text: 'hello',
  });
});

test('non-email wire messages are not forwarded as outbound events', () => {
  assert.equal(canonicalizeEmailSendEventContent('{"type":"email.inbound.v1"}'), null);
});
