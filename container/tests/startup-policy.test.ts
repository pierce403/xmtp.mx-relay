import assert from 'node:assert/strict';
import test from 'node:test';
import { RecoveryRequiredError } from '../src/snapshot.js';
import { startupFailureDisposition } from '../src/startup-policy.js';

test('recovery-required startup failures remain held for an operator', () => {
  assert.equal(
    startupFailureDisposition(new RecoveryRequiredError('identity mismatch')),
    'hold_for_operator',
  );
  assert.equal(
    startupFailureDisposition({ code: 'recovery_required' }),
    'hold_for_operator',
  );
});

test('transient startup failures force a process restart', () => {
  assert.equal(startupFailureDisposition(new Error('R2 temporarily unavailable')), 'restart_process');
  assert.equal(
    startupFailureDisposition(new Error('recovery_required: untyped error text')),
    'restart_process',
  );
});
