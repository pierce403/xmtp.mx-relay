import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIdentityStoragePreconditions } from '../src/identity-safety.js';

const inboxId = 'a'.repeat(64);
const databasePath = '/data/xmtp-production.db3';

test('existing database without restored inbox pin fails before Client construction', () => {
  assert.throws(
    () => assertIdentityStoragePreconditions({
      databaseExists: true,
      pinnedInboxId: null,
      expectedInboxId: inboxId,
      allowNewInstallation: false,
      databasePath,
    }),
    /refusing to construct Client or synthesize a replacement pin/,
  );
});

test('only explicit bootstrap may start with both database and pin absent', () => {
  assert.throws(
    () => assertIdentityStoragePreconditions({
      databaseExists: false,
      pinnedInboxId: null,
      expectedInboxId: inboxId,
      allowNewInstallation: false,
      databasePath,
    }),
    /refusing to construct Client or register/,
  );
  assert.doesNotThrow(() => assertIdentityStoragePreconditions({
    databaseExists: false,
    pinnedInboxId: null,
    expectedInboxId: inboxId,
    allowNewInstallation: true,
    databasePath,
  }));
});
