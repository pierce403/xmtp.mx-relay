import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectoryObjectStore } from '../src/object-store.js';
import {
  MAX_SNAPSHOT_PART_BYTES,
  readLatestManifest,
  sha256File,
  snapshotManifestSchema,
} from '../src/snapshot.js';

const PRODUCTION_CONFIRMATION = 'xmtp-mx-relay-production';

export type SnapshotUploadOptions = {
  inputDir: string;
  edgeUrl: string;
  confirmation: string;
  adminToken: string;
  manifestSigningKey: string;
  maxBackupBytes?: number;
};

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

function safeLocalObjectPath(root: string, key: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, key);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Snapshot object key escapes --input-dir: ${key}`);
  }
  return resolved;
}

function recoveryObjectUrl(edgeUrl: string, key: string): string {
  return `${edgeUrl}/internal/v1/admin/recovery/objects/${encodeURIComponent(key)}`;
}

async function responseError(response: Response, operation: string): Promise<Error> {
  const body = (await response.text()).slice(0, 4_096);
  return new Error(`${operation} failed (${response.status}): ${body || response.statusText}`);
}

function validateEdgeUrl(value: string): string {
  const url = new URL(value);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('--edge-url must use HTTPS (HTTP is allowed only for localhost)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('--edge-url cannot contain credentials, a query, or a fragment');
  }
  return url.toString().replace(/\/$/, '');
}

export async function uploadSnapshot(
  options: SnapshotUploadOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  snapshotId: string;
  prefix: string;
  objectCount: number;
  databaseBytes: number;
  databaseParts: number;
}> {
  if (options.confirmation !== PRODUCTION_CONFIRMATION) {
    throw new Error(`--confirm must be exactly ${PRODUCTION_CONFIRMATION}`);
  }
  if (Buffer.byteLength(options.adminToken, 'utf8') < 32) {
    throw new Error('CLOUDFLARE_RECOVERY_ADMIN_TOKEN must be at least 32 bytes');
  }
  if (Buffer.byteLength(options.manifestSigningKey, 'utf8') < 32) {
    throw new Error('XMTP_SNAPSHOT_SIGNING_KEY must be at least 32 bytes');
  }
  const inputDir = path.resolve(options.inputDir);
  const edgeUrl = validateEdgeUrl(options.edgeUrl);
  const maxBackupBytes = options.maxBackupBytes ?? 1024 * 1024 * 1024;

  // Locate the sole exported latest.json without trusting its fields first.
  const latestCandidates: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are forbidden in a snapshot export: ${filename}`);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile() && entry.name === 'latest.json') latestCandidates.push(filename);
    }
  };
  await walk(inputDir);
  if (latestCandidates.length !== 1) {
    throw new Error(`Expected exactly one latest.json under --input-dir, found ${latestCandidates.length}`);
  }
  const latestPath = latestCandidates[0]!;
  const rawManifest = snapshotManifestSchema.parse(JSON.parse(await fs.readFile(latestPath, 'utf8')));
  const marker = `/snapshots/${rawManifest.snapshotId}/database/`;
  const markerIndex = rawManifest.database.parts[0]!.key.indexOf(marker);
  if (markerIndex <= 0) throw new Error('Cannot derive the snapshot prefix from its first database part');
  const prefix = rawManifest.database.parts[0]!.key.slice(0, markerIndex);
  const expectedLatestPath = safeLocalObjectPath(inputDir, `${prefix}/latest.json`);
  if (path.resolve(latestPath) !== expectedLatestPath) {
    throw new Error('latest.json is not stored at the manifest-derived prefix');
  }

  const manifest = await readLatestManifest({
    store: new DirectoryObjectStore(inputDir),
    prefix,
    xmtpEnv: rawManifest.xmtpEnv,
    expectedInboxId: rawManifest.inboxId,
    expectedInstallationId: rawManifest.installationId,
    manifestSigningKey: options.manifestSigningKey,
    maxBackupBytes,
    maxPartBytes: MAX_SNAPSHOT_PART_BYTES,
    freeSpaceMarginBytes: 0,
  });
  if (!manifest) throw new Error('Verified latest manifest disappeared during upload preparation');

  const immutableManifestKey = `${prefix}/snapshots/${manifest.snapshotId}/manifest.json`;
  const latestBytes = await fs.readFile(latestPath);
  const immutableManifestBytes = await fs.readFile(safeLocalObjectPath(inputDir, immutableManifestKey));
  if (!latestBytes.equals(immutableManifestBytes)) {
    throw new Error('latest.json does not exactly match the immutable manifest.json');
  }

  const objects = [
    ...manifest.database.parts.map((part) => ({ key: part.key, sha256: part.sha256, bytes: part.bytes })),
    manifest.pinnedInbox,
    { key: immutableManifestKey, ...(await sha256File(safeLocalObjectPath(inputDir, immutableManifestKey))) },
    { key: `${prefix}/latest.json`, ...(await sha256File(latestPath)) },
  ];

  // Verify the complete export before the first network mutation. The second
  // per-object check below catches a local file changed during upload.
  const databaseHash = createHash('sha256');
  let databaseBytes = 0;
  for (const part of manifest.database.parts) {
    const filename = safeLocalObjectPath(inputDir, part.key);
    const digest = await sha256File(filename);
    if (digest.sha256 !== part.sha256 || digest.bytes !== part.bytes) {
      throw new Error(`Local snapshot database part failed verification: ${part.key}`);
    }
    const value = await fs.readFile(filename);
    databaseHash.update(value);
    databaseBytes += value.byteLength;
  }
  if (
    databaseBytes !== manifest.database.bytes
    || databaseHash.digest('hex') !== manifest.database.sha256
  ) {
    throw new Error('Local snapshot database failed concatenated SHA-256/size verification');
  }
  for (const object of objects.slice(manifest.database.parts.length)) {
    const digest = await sha256File(safeLocalObjectPath(inputDir, object.key));
    if (digest.sha256 !== object.sha256 || digest.bytes !== object.bytes) {
      throw new Error(`Local snapshot object failed SHA-256/size verification: ${object.key}`);
    }
  }

  for (const [index, object] of objects.entries()) {
    const isLatest = index === objects.length - 1;
    const filename = safeLocalObjectPath(inputDir, object.key);
    const digest = await sha256File(filename);
    if (digest.sha256 !== object.sha256 || digest.bytes !== object.bytes) {
      throw new Error(`Local snapshot object failed SHA-256/size verification: ${object.key}`);
    }
    if (digest.bytes > MAX_SNAPSHOT_PART_BYTES) {
      throw new Error(`Snapshot upload object exceeds the hard 32 MiB request limit: ${object.key}`);
    }
    const value = await fs.readFile(filename);
    const headers = new Headers({
      authorization: `Bearer ${options.adminToken}`,
      'content-length': String(value.byteLength),
      'content-type': 'application/octet-stream',
      'x-object-sha256': digest.sha256,
      'x-recovery-confirm': options.confirmation,
    });
    if (!isLatest) headers.set('if-none-match', '*');
    const requestBody = value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer;
    const put = await fetchImpl(recoveryObjectUrl(edgeUrl, object.key), {
      method: 'PUT',
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(180_000),
    });
    if (!put.ok && put.status !== 412) throw await responseError(put, `PUT ${object.key}`);

    const get = await fetchImpl(recoveryObjectUrl(edgeUrl, object.key), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${options.adminToken}`,
        'x-recovery-confirm': options.confirmation,
      },
      signal: AbortSignal.timeout(180_000),
    });
    if (!get.ok) throw await responseError(get, `GET ${object.key}`);
    const readback = Buffer.from(await get.arrayBuffer());
    const readbackDigest = await crypto.subtle.digest('SHA-256', readback);
    const readbackSha = Buffer.from(readbackDigest).toString('hex');
    if (readback.byteLength !== digest.bytes || readbackSha !== digest.sha256) {
      throw new Error(`Uploaded snapshot object failed readback verification: ${object.key}`);
    }
  }

  return {
    snapshotId: manifest.snapshotId,
    prefix,
    objectCount: objects.length,
    databaseBytes: manifest.database.bytes,
    databaseParts: manifest.database.parts.length,
  };
}

async function main(): Promise<void> {
  const result = await uploadSnapshot({
    inputDir: option('input-dir'),
    edgeUrl: option('edge-url'),
    confirmation: option('confirm'),
    adminToken: process.env.CLOUDFLARE_RECOVERY_ADMIN_TOKEN?.trim() ?? '',
    manifestSigningKey: process.env.XMTP_SNAPSHOT_SIGNING_KEY?.trim() ?? '',
    maxBackupBytes: Number(option('max-backup-bytes', String(1024 * 1024 * 1024))),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
