import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { uploadSnapshot } from '../scripts/upload-snapshot.js';
import { DirectoryObjectStore } from '../src/object-store.js';
import {
  PINNED_INBOX_FILENAME,
  createQuiescedSnapshot,
  databasePath,
} from '../src/snapshot.js';

test('offline uploader verifies, uploads immutable objects, publishes latest last, and reads back', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xmtp-upload-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const exportDir = path.join(root, 'export');
  const prefix = 'xmtp-mx-relay-production/xmtp';
  const inboxId = 'a'.repeat(64);
  const signingKey = 'snapshot-upload-test-signing-key-32-bytes';
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(databasePath(dataDir, 'production', inboxId), crypto.randomBytes(48 * 1024));
  await fs.writeFile(path.join(dataDir, PINNED_INBOX_FILENAME), `${inboxId}\n`);
  const manifest = await createQuiescedSnapshot({
    store: new DirectoryObjectStore(exportDir),
    prefix,
    dataDir,
    xmtpEnv: 'production',
    expectedInboxId: inboxId,
    expectedInstallationId: 'installation-upload-test',
    currentInboxId: inboxId,
    installationId: 'installation-upload-test',
    sourceBootId: 'offline-upload-test',
    reason: 'test-export',
    replayAfter: new Date(0).toISOString(),
    replayWatermark: null,
    manifestSigningKey: signingKey,
    partSizeBytes: 16 * 1024,
    maxBackupBytes: 1024 * 1024,
    freeSpaceMarginBytes: 0,
  });

  const remote = new Map<string, Buffer>();
  const putOrder: string[] = [];
  const immutablePreconditions: Array<string | null> = [];
  const confirmations: Array<string | null> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const marker = '/internal/v1/admin/recovery/objects/';
    const key = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
    const headers = new Headers(init?.headers);
    confirmations.push(headers.get('x-recovery-confirm'));
    if (init?.method === 'PUT') {
      const value = Buffer.from(await new Response(init.body).arrayBuffer());
      assert.equal(headers.get('content-length'), String(value.byteLength));
      putOrder.push(key);
      immutablePreconditions.push(headers.get('if-none-match'));
      remote.set(key, value);
      return Response.json({ ok: true }, { status: 201 });
    }
    const value = remote.get(key);
    return value ? new Response(value, { status: 200 }) : new Response(null, { status: 404 });
  }) as typeof fetch;

  const result = await uploadSnapshot({
    inputDir: exportDir,
    edgeUrl: 'https://relay.example.test',
    confirmation: 'xmtp-mx-relay-production',
    adminToken: 'admin-token-for-upload-test-at-least-32-bytes',
    manifestSigningKey: signingKey,
    maxBackupBytes: 1024 * 1024,
  }, fakeFetch);

  assert.equal(result.snapshotId, manifest.snapshotId);
  assert.equal(result.databaseParts, 3);
  assert.equal(putOrder.at(-1), `${prefix}/latest.json`);
  assert.equal(immutablePreconditions.at(-1), null);
  assert.ok(immutablePreconditions.slice(0, -1).every((value) => value === '*'));
  assert.ok(confirmations.every((value) => value === 'xmtp-mx-relay-production'));
});

test('offline uploader detects a corrupt later part before any network mutation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xmtp-upload-corrupt-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const exportDir = path.join(root, 'export');
  const prefix = 'xmtp-mx-relay-production/xmtp';
  const inboxId = 'b'.repeat(64);
  const signingKey = 'snapshot-upload-corrupt-signing-key-32-bytes';
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(databasePath(dataDir, 'production', inboxId), crypto.randomBytes(48 * 1024));
  await fs.writeFile(path.join(dataDir, PINNED_INBOX_FILENAME), `${inboxId}\n`);
  const manifest = await createQuiescedSnapshot({
    store: new DirectoryObjectStore(exportDir),
    prefix,
    dataDir,
    xmtpEnv: 'production',
    expectedInboxId: inboxId,
    expectedInstallationId: 'installation-upload-corrupt-test',
    currentInboxId: inboxId,
    installationId: 'installation-upload-corrupt-test',
    sourceBootId: 'offline-upload-corrupt-test',
    reason: 'test-corrupt-export',
    replayAfter: new Date(0).toISOString(),
    replayWatermark: null,
    manifestSigningKey: signingKey,
    partSizeBytes: 16 * 1024,
    maxBackupBytes: 1024 * 1024,
    freeSpaceMarginBytes: 0,
  });
  const corruptPart = manifest.database.parts.at(-1)!;
  const corruptPath = path.join(exportDir, corruptPart.key);
  const value = await fs.readFile(corruptPath);
  value[0] ^= 0xff;
  await fs.writeFile(corruptPath, value);
  let networkCalls = 0;

  await assert.rejects(
    uploadSnapshot({
      inputDir: exportDir,
      edgeUrl: 'https://relay.example.test',
      confirmation: 'xmtp-mx-relay-production',
      adminToken: 'admin-token-for-upload-test-at-least-32-bytes',
      manifestSigningKey: signingKey,
      maxBackupBytes: 1024 * 1024,
    }, (async () => {
      networkCalls += 1;
      return new Response(null, { status: 500 });
    }) as typeof fetch),
    /database part failed verification/,
  );
  assert.equal(networkCalls, 0);
});
