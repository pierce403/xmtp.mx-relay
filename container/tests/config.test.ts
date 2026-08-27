import assert from 'node:assert/strict';
import test from 'node:test';
import { BOOTSTRAP_CONFIRMATION, loadConfig } from '../src/config.js';

const inboxId = 'a'.repeat(64);

function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PORT: '8080',
    DATA_DIR: '/tmp/xmtp-mx-config-test',
    XMTP_ENV: 'production',
    XMTP_BOT_KEY: `0x${'1'.repeat(64)}`,
    XMTP_DEAN_ADDRESS: `0x${'2'.repeat(40)}`,
    XMTP_EXPECTED_INBOX_ID: inboxId,
    XMTP_EXPECTED_INSTALLATION_ID: 'installation-1',
    CONTAINER_SHARED_SECRET: 's'.repeat(32),
    XMTP_SNAPSHOT_SIGNING_KEY: 'k'.repeat(32),
    ...overrides,
  };
}

test('production defaults to refusing a new XMTP installation', () => {
  const config = loadConfig(productionEnv());
  assert.equal(config.allowNewInstallation, false);
  assert.equal(config.xmtpExpectedInboxId, inboxId);
  assert.equal(config.xmtpExpectedInstallationId, 'installation-1');
  assert.equal(config.snapshotSigningKey, 'k'.repeat(32));
  assert.equal(config.backupPartBytes, 16 * 1024 * 1024);
  assert.equal(config.backupIntervalMs, 3_600_000);
});

test('snapshot signing key is independent and required', () => {
  assert.throws(
    () => loadConfig(productionEnv({ XMTP_SNAPSHOT_SIGNING_KEY: undefined })),
    /XMTP_SNAPSHOT_SIGNING_KEY/,
  );
});

test('snapshot parts are hard-capped at 32 MiB and cannot exceed total backup size', () => {
  assert.throws(
    () => loadConfig(productionEnv({ XMTP_BACKUP_PART_BYTES: String(32 * 1024 * 1024 + 1) })),
    /less than or equal to 33554432/,
  );
  assert.throws(
    () => loadConfig(productionEnv({
      XMTP_BACKUP_PART_BYTES: String(16 * 1024 * 1024),
      XMTP_MAX_BACKUP_BYTES: String(8 * 1024 * 1024),
    })),
    /cannot exceed XMTP_MAX_BACKUP_BYTES/,
  );
});

test('production requires independently configured inbox and installation IDs', () => {
  assert.throws(
    () => loadConfig(productionEnv({ XMTP_EXPECTED_INBOX_ID: undefined })),
    /XMTP_EXPECTED_INBOX_ID is required/,
  );
  assert.throws(
    () => loadConfig(productionEnv({ XMTP_EXPECTED_INSTALLATION_ID: undefined })),
    /XMTP_EXPECTED_INSTALLATION_ID is required/,
  );
});

test('new-install bootstrap has one explicit confirmation gate', () => {
  assert.throws(
    () => loadConfig(productionEnv({ XMTP_ALLOW_NEW_INSTALLATION: 'true' })),
    /XMTP_BOOTSTRAP_CONFIRM/,
  );
  const config = loadConfig(
    productionEnv({
      XMTP_ALLOW_NEW_INSTALLATION: 'true',
      XMTP_BOOTSTRAP_CONFIRM: BOOTSTRAP_CONFIRMATION,
      XMTP_EXPECTED_INSTALLATION_ID: undefined,
    }),
  );
  assert.equal(config.allowNewInstallation, true);
});

test('emergency installation revocation is forbidden', () => {
  assert.throws(
    () => loadConfig(productionEnv({ XMTP_EMERGENCY_REVOKE_INSTALLATIONS: 'true' })),
    /forbidden/,
  );
});
