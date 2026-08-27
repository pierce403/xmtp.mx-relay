import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DirectoryObjectStore } from '../src/object-store.js';
import {
  PINNED_INBOX_FILENAME,
  createQuiescedSnapshot,
  databasePath,
  prepareStorage,
  sha256File,
} from '../src/snapshot.js';

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xmtp-mx-recovery-drill-'));
  const dataDir = path.join(root, 'ephemeral-data');
  const objectDir = path.join(root, 'r2');
  const inboxId = 'a'.repeat(64);
  const installationId = 'installation-recovery-drill';
  const prefix = 'xmtp-mx-relay-production/xmtp';
  const replayAfter = '2026-08-27T00:00:00.000Z';
  const replayWatermark = '2026-08-27T00:05:00.000Z';
  const manifestSigningKey = 'recovery-drill-signing-key-not-for-production';

  try {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const dbPath = databasePath(dataDir, 'production', inboxId);
    await fs.writeFile(dbPath, crypto.randomBytes(128 * 1024), { mode: 0o600 });
    await fs.writeFile(path.join(dataDir, PINNED_INBOX_FILENAME), `${inboxId}\n`, { mode: 0o600 });
    const originalDigest = await sha256File(dbPath);
    const store = new DirectoryObjectStore(objectDir);

    const manifest = await createQuiescedSnapshot({
      store,
      prefix,
      dataDir,
      xmtpEnv: 'production',
      expectedInboxId: inboxId,
      expectedInstallationId: installationId,
      currentInboxId: inboxId,
      installationId,
      sourceBootId: 'recovery-drill-source',
      reason: 'recovery-drill',
      replayAfter,
      replayWatermark,
      manifestSigningKey,
      partSizeBytes: 32 * 1024,
      maxBackupBytes: 1024 * 1024,
      freeSpaceMarginBytes: 0,
    });

    // This target is a tool-created temporary directory. Removing it simulates
    // Cloudflare replacing the entire ephemeral Container filesystem.
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });

    const prepared = await prepareStorage({
      store,
      prefix,
      dataDir,
      xmtpEnv: 'production',
      expectedInboxId: inboxId,
      expectedInstallationId: installationId,
      allowNewInstallation: false,
      manifestSigningKey,
      maxBackupBytes: 1024 * 1024,
      maxPartBytes: 32 * 1024,
      freeSpaceMarginBytes: 0,
    });
    const restoredDigest = await sha256File(dbPath);
    const restoredPin = (await fs.readFile(path.join(dataDir, PINNED_INBOX_FILENAME), 'utf8')).trim();

    if (prepared.mode !== 'restored') throw new Error(`Expected restored mode, got ${prepared.mode}`);
    if (restoredDigest.sha256 !== originalDigest.sha256 || restoredDigest.bytes !== originalDigest.bytes) {
      throw new Error('Restored database differs from the quiesced source');
    }
    if (restoredPin !== inboxId) throw new Error('Restored pin differs from expected inbox ID');
    if (prepared.manifest.installationId !== installationId) throw new Error('Installation ID changed');
    if (prepared.replayAfter !== replayAfter) throw new Error('Replay cutoff advanced during snapshot');

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          simulatedFilesystemDestruction: true,
          allowNewInstallation: false,
          clientConstructed: false,
          snapshotId: manifest.snapshotId,
          inboxId,
          installationId,
          databaseSha256: restoredDigest.sha256,
          replayAfter: prepared.replayAfter,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
