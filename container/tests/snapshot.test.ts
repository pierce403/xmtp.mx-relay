import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DirectoryObjectStore,
  ObjectStoreRequestError,
  type ObjectStore,
} from '../src/object-store.js';
import {
  PINNED_INBOX_FILENAME,
  RecoveryRequiredError,
  assertSufficientFreeSpace,
  claimBootstrapAttempt,
  createQuiescedSnapshot,
  databasePath,
  latestManifestKey,
  prepareStorage,
  sha256Bytes,
  sha256File,
} from '../src/snapshot.js';

const inboxId = 'a'.repeat(64);
const otherInboxId = 'b'.repeat(64);
const installationId = 'installation-existing-1';
const prefix = 'xmtp-mx-relay-production/xmtp';
const replayAfter = '2026-08-26T23:55:00.000Z';
const replayWatermark = '2026-08-27T00:00:00.000Z';
const manifestSigningKey = 'snapshot-test-signing-key-at-least-32-bytes';
const partSizeBytes = 16 * 1024;

const snapshotPolicy = {
  manifestSigningKey,
  maxBackupBytes: 1024 * 1024,
  maxPartBytes: partSizeBytes,
  freeSpaceMarginBytes: 0,
} as const;

async function fixture(t: test.TestContext): Promise<{
  root: string;
  dataDir: string;
  objectDir: string;
  dbPath: string;
  store: DirectoryObjectStore;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xmtp-snapshot-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const objectDir = path.join(root, 'r2');
  await fs.mkdir(dataDir, { recursive: true });
  const dbPath = databasePath(dataDir, 'production', inboxId);
  await fs.writeFile(dbPath, crypto.randomBytes(64 * 1024), { mode: 0o600 });
  await fs.writeFile(path.join(dataDir, PINNED_INBOX_FILENAME), `${inboxId}\n`, { mode: 0o600 });
  return { root, dataDir, objectDir, dbPath, store: new DirectoryObjectStore(objectDir) };
}

async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return createQuiescedSnapshot({
    store: f.store,
    prefix,
    dataDir: f.dataDir,
    xmtpEnv: 'production',
    expectedInboxId: inboxId,
    expectedInstallationId: installationId,
    currentInboxId: inboxId,
    installationId,
    sourceBootId: 'test-boot',
    reason: 'test',
    replayAfter,
    replayWatermark,
    manifestSigningKey,
    partSizeBytes,
    maxBackupBytes: snapshotPolicy.maxBackupBytes,
    freeSpaceMarginBytes: 0,
  });
}

test('closed database snapshot restores exact bytes, pin, installation, and replay cutoff', async (t) => {
  const f = await fixture(t);
  const sourceDigest = await sha256File(f.dbPath);
  const manifest = await snapshot(f);
  assert.notEqual(manifest.createdAt, manifest.replayAfter);
  assert.equal(manifest.version, 2);
  assert.equal(manifest.database.parts.length, 4);
  assert.ok(manifest.database.parts.every((part) => part.bytes <= partSizeBytes));
  assert.deepEqual(
    manifest.database.parts.map((part) => part.offset),
    [0, partSizeBytes, partSizeBytes * 2, partSizeBytes * 3],
  );

  await fs.rm(f.dataDir, { recursive: true, force: true });
  await fs.mkdir(f.dataDir, { recursive: true });
  const prepared = await prepareStorage({
    store: f.store,
    prefix,
    dataDir: f.dataDir,
    xmtpEnv: 'production',
    expectedInboxId: inboxId,
    expectedInstallationId: installationId,
    allowNewInstallation: false,
    ...snapshotPolicy,
  });

  assert.equal(prepared.mode, 'restored');
  assert.equal(prepared.manifest.installationId, installationId);
  assert.equal(prepared.replayAfter, replayAfter);
  assert.deepEqual(await sha256File(f.dbPath), sourceDigest);
  assert.equal(
    (await fs.readFile(path.join(f.dataDir, PINNED_INBOX_FILENAME), 'utf8')).trim(),
    inboxId,
  );
});

test('snapshot time never advances the safely processed source watermark', async (t) => {
  const f = await fixture(t);
  const manifest = await createQuiescedSnapshot({
    store: f.store,
    prefix,
    dataDir: f.dataDir,
    xmtpEnv: 'production',
    expectedInboxId: inboxId,
    expectedInstallationId: installationId,
    currentInboxId: inboxId,
    installationId,
    sourceBootId: 'retry-aborted-before-edge-ack',
    reason: 'test-edge-retry-aborted',
    replayAfter,
    replayWatermark: null,
    manifestSigningKey,
    partSizeBytes,
    maxBackupBytes: snapshotPolicy.maxBackupBytes,
    freeSpaceMarginBytes: 0,
  });
  assert.equal(manifest.replayAfter, replayAfter);
  assert.equal(manifest.replayWatermark, null);
  assert.ok(Date.parse(manifest.createdAt) > Date.parse(manifest.replayAfter));
});

test('missing local state and missing R2 snapshot fail closed before XMTP construction', async (t) => {
  const f = await fixture(t);
  await fs.rm(f.dataDir, { recursive: true, force: true });
  await fs.rm(f.objectDir, { recursive: true, force: true });
  await assert.rejects(
    prepareStorage({
      store: f.store,
      prefix,
      dataDir: f.dataDir,
      xmtpEnv: 'production',
      expectedInboxId: inboxId,
      expectedInstallationId: installationId,
      allowNewInstallation: false,
      ...snapshotPolicy,
    }),
    (error: unknown) => error instanceof RecoveryRequiredError && /refusing to construct Client/.test(error.message),
  );
});

test('normal production refuses unanchored local DB state', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareStorage({
      store: f.store,
      prefix,
      dataDir: f.dataDir,
      xmtpEnv: 'production',
      expectedInboxId: inboxId,
      expectedInstallationId: installationId,
      allowNewInstallation: false,
      ...snapshotPolicy,
    }),
    /no authenticated D1-anchored snapshot lineage/,
  );
});

test('runtime recovery unconditionally rejects unsigned v1 manifests', async (t) => {
  const f = await fixture(t);
  const legacy = Buffer.from(JSON.stringify({ version: 1 }));
  await f.store.putBytes(latestManifestKey(prefix), legacy, sha256Bytes(legacy));
  await fs.rm(f.dataDir, { recursive: true, force: true });
  await assert.rejects(
    prepareStorage({
      store: f.store,
      prefix,
      dataDir: f.dataDir,
      xmtpEnv: 'production',
      expectedInboxId: inboxId,
      expectedInstallationId: installationId,
      allowNewInstallation: false,
      ...snapshotPolicy,
    }),
    /R2 latest manifest is invalid/,
  );
});

test('persistent bootstrap marker prevents a second registration attempt after a crash', async (t) => {
  const f = await fixture(t);
  await claimBootstrapAttempt({
    store: f.store,
    prefix,
    expectedInboxId: inboxId,
    sourceBootId: 'first-bootstrap-boot',
  });
  await assert.rejects(
    claimBootstrapAttempt({
      store: f.store,
      prefix,
      expectedInboxId: inboxId,
      sourceBootId: 'replacement-after-crash',
    }),
    /prior bootstrap attempt marker exists/,
  );
});

test('independent expected inbox ID rejects a mismatched snapshot', async (t) => {
  const f = await fixture(t);
  await snapshot(f);
  await fs.rm(f.dataDir, { recursive: true, force: true });
  await assert.rejects(
    prepareStorage({
      store: f.store,
      prefix,
      dataDir: f.dataDir,
      xmtpEnv: 'production',
      expectedInboxId: otherInboxId,
      expectedInstallationId: installationId,
      allowNewInstallation: false,
      ...snapshotPolicy,
    }),
    /does not match XMTP_EXPECTED_INBOX_ID/,
  );
});

test('tampered R2 database is rejected by SHA-256 and size verification', async (t) => {
  const f = await fixture(t);
  const manifest = await snapshot(f);
  const storedDb = path.join(f.objectDir, manifest.database.parts[0]!.key);
  await fs.appendFile(storedDb, Buffer.from('tamper'));
  await fs.rm(f.dataDir, { recursive: true, force: true });
  await assert.rejects(
    prepareStorage({
      store: f.store,
      prefix,
      dataDir: f.dataDir,
      xmtpEnv: 'production',
      expectedInboxId: inboxId,
      expectedInstallationId: installationId,
      allowNewInstallation: false,
      ...snapshotPolicy,
    }),
    /exceeds|failed verification/,
  );
});

test('missing immutable database part fails closed without installing partial state', async (t) => {
  const f = await fixture(t);
  const manifest = await snapshot(f);
  const missingPart = manifest.database.parts[1]!;
  await fs.rm(path.join(f.objectDir, missingPart.key));
  await fs.rm(f.dataDir, { recursive: true, force: true });
  await assert.rejects(
    prepareStorage({
      store: f.store,
      prefix,
      dataDir: f.dataDir,
      xmtpEnv: 'production',
      expectedInboxId: inboxId,
      expectedInstallationId: installationId,
      allowNewInstallation: false,
      ...snapshotPolicy,
    }),
    /database part is missing/,
  );
  await assert.rejects(fs.stat(f.dbPath), { code: 'ENOENT' });
});

test('same-size database part corruption fails per-part SHA verification', async (t) => {
  const f = await fixture(t);
  const manifest = await snapshot(f);
  const part = manifest.database.parts[2]!;
  const filename = path.join(f.objectDir, part.key);
  const value = await fs.readFile(filename);
  value[0] ^= 0xff;
  await fs.writeFile(filename, value);
  await fs.rm(f.dataDir, { recursive: true, force: true });
  await assert.rejects(
    prepareStorage({
      store: f.store,
      prefix,
      dataDir: f.dataDir,
      xmtpEnv: 'production',
      expectedInboxId: inboxId,
      expectedInstallationId: installationId,
      allowNewInstallation: false,
      ...snapshotPolicy,
    }),
    /part 2 failed SHA-256/,
  );
});

test('manifest field tampering is rejected by HMAC before restore', async (t) => {
  const f = await fixture(t);
  await snapshot(f);
  const latestPath = path.join(f.objectDir, latestManifestKey(prefix));
  const manifest = JSON.parse(await fs.readFile(latestPath, 'utf8')) as Record<string, unknown>;
  manifest.reason = 'attacker-modified';
  await fs.writeFile(latestPath, JSON.stringify(manifest));
  await fs.rm(f.dataDir, { recursive: true, force: true });
  await assert.rejects(
    prepareStorage({
      store: f.store,
      prefix,
      dataDir: f.dataDir,
      xmtpEnv: 'production',
      expectedInboxId: inboxId,
      expectedInstallationId: installationId,
      allowNewInstallation: false,
      ...snapshotPolicy,
    }),
    /HMAC signature verification failed/,
  );
});

test('manifest HMAC is stable across JSON property ordering', async (t) => {
  const f = await fixture(t);
  await snapshot(f);
  const latestPath = path.join(f.objectDir, latestManifestKey(prefix));
  const manifest = JSON.parse(await fs.readFile(latestPath, 'utf8')) as Record<string, unknown>;
  await fs.writeFile(latestPath, JSON.stringify(Object.fromEntries(Object.entries(manifest).reverse())));
  await fs.rm(f.dataDir, { recursive: true, force: true });
  const prepared = await prepareStorage({
    store: f.store,
    prefix,
    dataDir: f.dataDir,
    xmtpEnv: 'production',
    expectedInboxId: inboxId,
    expectedInstallationId: installationId,
    allowNewInstallation: false,
    ...snapshotPolicy,
  });
  assert.equal(prepared.mode, 'restored');
});

test('free-space preflight fails closed before restore work', () => {
  assert.throws(
    () => assertSufficientFreeSpace({
      operation: 'XMTP snapshot restore',
      availableBytes: 99n,
      requiredBytes: 100,
    }),
    (error: unknown) => error instanceof RecoveryRequiredError && /only 99 are available/.test(error.message),
  );
});

test('freshness-anchor rejection prevents snapshot publication', async (t) => {
  const f = await fixture(t);
  const rejectingStore: ObjectStore = {
    getBytes: (key, maxBytes) => f.store.getBytes(key, maxBytes),
    getToFile: (key, destination) => f.store.getToFile(key, destination),
    putBytes: async (key, value, sha256) => {
      if (key === latestManifestKey(prefix)) {
        throw new ObjectStoreRequestError(409, 'stale_snapshot_pointer');
      }
      await f.store.putBytes(key, value, sha256);
    },
    putBytesIfAbsent: (key, value, sha256) => f.store.putBytesIfAbsent(key, value, sha256),
    putFile: (key, source, sha256) => f.store.putFile(key, source, sha256),
  };

  await assert.rejects(
    createQuiescedSnapshot({
      store: rejectingStore,
      prefix,
      dataDir: f.dataDir,
      xmtpEnv: 'production',
      expectedInboxId: inboxId,
      expectedInstallationId: installationId,
      currentInboxId: inboxId,
      installationId,
      sourceBootId: 'stale-publisher',
      reason: 'rollback-rejection-test',
      replayAfter,
      replayWatermark,
      manifestSigningKey,
      partSizeBytes,
      maxBackupBytes: snapshotPolicy.maxBackupBytes,
      freeSpaceMarginBytes: 0,
    }),
    (error: unknown) => error instanceof RecoveryRequiredError && /stale_snapshot_pointer/.test(error.message),
  );
  await assert.rejects(
    f.store.getBytes(latestManifestKey(prefix)),
    /Object not found/,
  );
});

test('nonempty SQLite WAL and SHM sidecars are rejected instead of copied', async (t) => {
  for (const suffix of ['-wal', '-shm']) {
    await t.test(suffix, async (subtest) => {
      const f = await fixture(subtest);
      await fs.writeFile(`${f.dbPath}${suffix}`, Buffer.from('not-checkpointed'));
      await assert.rejects(snapshot(f), /refusing unsafe snapshot/);
    });
  }
});
