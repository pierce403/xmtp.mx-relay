import fs from 'node:fs/promises';
import path from 'node:path';
import { DirectoryObjectStore } from '../src/object-store.js';
import {
  DEFAULT_FREE_SPACE_MARGIN_BYTES,
  DEFAULT_SNAPSHOT_PART_BYTES,
  createQuiescedSnapshot,
} from '../src/snapshot.js';

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    return value;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required option --${name}`);
}

async function main(): Promise<void> {
  const manifestSigningKey = process.env.XMTP_SNAPSHOT_SIGNING_KEY?.trim() ?? '';
  if (Buffer.byteLength(manifestSigningKey, 'utf8') < 32) {
    throw new Error('XMTP_SNAPSHOT_SIGNING_KEY (at least 32 bytes) is required in the environment');
  }
  const dataDir = path.resolve(option('data-dir'));
  const outputDir = path.resolve(option('output-dir'));
  const xmtpEnv = option('xmtp-env', 'production');
  if (xmtpEnv !== 'production' && xmtpEnv !== 'dev' && xmtpEnv !== 'local') {
    throw new Error('--xmtp-env must be production, dev, or local');
  }
  const inboxId = option('inbox-id').toLowerCase();
  const installationId = option('installation-id');
  const prefix = option('prefix', 'xmtp-mx-relay-production/xmtp').replace(/^\/+|\/+$/g, '');
  const replayWatermark = option('replay-watermark', '') || null;
  const replayAfter = option(
    'replay-after',
    replayWatermark
      ? new Date(Date.parse(replayWatermark) - 5 * 60_000).toISOString()
      : new Date(0).toISOString(),
  );
  const partSizeBytes = Number(option('part-bytes', String(DEFAULT_SNAPSHOT_PART_BYTES)));
  const maxBackupBytes = Number(option('max-backup-bytes', String(1024 * 1024 * 1024)));

  if (dataDir === outputDir || dataDir.startsWith(`${outputDir}${path.sep}`) || outputDir.startsWith(`${dataDir}${path.sep}`)) {
    throw new Error('--data-dir and --output-dir must be separate directories');
  }
  if (outputDir === path.parse(outputDir).root) throw new Error('--output-dir cannot be a filesystem root');
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });

  const manifest = await createQuiescedSnapshot({
    store: new DirectoryObjectStore(outputDir),
    prefix,
    dataDir,
    xmtpEnv,
    expectedInboxId: inboxId,
    expectedInstallationId: installationId,
    currentInboxId: inboxId,
    installationId,
    sourceBootId: `offline-export-${Date.now()}`,
    reason: 'railway-migration-export',
    replayAfter,
    replayWatermark,
    manifestSigningKey,
    partSizeBytes,
    maxBackupBytes,
    freeSpaceMarginBytes: DEFAULT_FREE_SPACE_MARGIN_BYTES,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        outputDir,
        latestManifest: path.join(outputDir, prefix, 'latest.json'),
        snapshotId: manifest.snapshotId,
        inboxId: manifest.inboxId,
        installationId: manifest.installationId,
        databaseSha256: manifest.database.sha256,
        databaseBytes: manifest.database.bytes,
        databaseParts: manifest.database.parts.length,
        partSizeBytes: manifest.database.partSizeBytes,
        replayAfter: manifest.replayAfter,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
