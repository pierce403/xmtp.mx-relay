import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  ObjectNotFoundError,
  ObjectStoreRequestError,
  type ObjectStore,
} from './object-store.js';

export const PINNED_INBOX_FILENAME = 'xmtp-inbox-id.txt';
export const DEFAULT_SNAPSHOT_PART_BYTES = 16 * 1024 * 1024;
export const MAX_SNAPSHOT_PART_BYTES = 32 * 1024 * 1024;
export const DEFAULT_FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

const DEFAULT_MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_PARTS = 8_192;
const MANIFEST_HMAC_DOMAIN = Buffer.from('xmtp.mx/xmtp-snapshot-manifest/v2\0', 'utf8');

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const inboxIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

const storedObjectSchema = z
  .object({
    key: z.string().min(1).max(1_024),
    sha256: sha256Schema,
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const snapshotPartSchema = storedObjectSchema
  .extend({
    index: z.number().int().nonnegative().max(MAX_SNAPSHOT_PARTS - 1),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    bytes: z.number().int().positive().max(MAX_SNAPSHOT_PART_BYTES),
  })
  .strict();

const chunkedDatabaseSchema = z
  .object({
    sha256: sha256Schema,
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    partSizeBytes: z.number().int().positive().max(MAX_SNAPSHOT_PART_BYTES),
    parts: z.array(snapshotPartSchema).min(1).max(MAX_SNAPSHOT_PARTS),
  })
  .strict();

const commonManifestFields = {
  snapshotId: z.string().uuid(),
  createdAt: z.string().datetime(),
  xmtpEnv: z.enum(['production', 'dev', 'local']),
  inboxId: inboxIdSchema,
  installationId: z.string().min(1).max(512),
  pinnedInbox: storedObjectSchema,
  sourceBootId: z.string().min(1),
  sourceDeploymentId: z.string().nullable(),
  reason: z.string().min(1).max(256),
  replayAfter: z.string().datetime(),
  replayWatermark: z.string().datetime().nullable(),
} as const;

const snapshotManifestV2Schema = z
  .object({
    version: z.literal(2),
    ...commonManifestFields,
    database: chunkedDatabaseSchema,
    signature: z
      .object({
        algorithm: z.literal('hmac-sha256'),
        value: sha256Schema,
      })
      .strict(),
  })
  .strict();

export const snapshotManifestSchema = z
  .object(snapshotManifestV2Schema.shape)
  .strict()
  .superRefine((manifest, context) => {
    if (
      manifest.replayWatermark &&
      Date.parse(manifest.replayAfter) > Date.parse(manifest.replayWatermark)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['replayAfter'],
        message: 'replayAfter cannot be later than replayWatermark',
      });
    }
  });

export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;
export type SnapshotManifestV2 = SnapshotManifest;
export type UnsignedSnapshotManifestV2 = Omit<SnapshotManifestV2, 'signature'>;

type SnapshotReadPolicy = {
  manifestSigningKey: string;
  maxBackupBytes?: number | undefined;
  maxPartBytes?: number | undefined;
  freeSpaceMarginBytes?: number | undefined;
};

type ResolvedSnapshotPolicy = {
  manifestSigningKey: string;
  maxBackupBytes: number;
  maxPartBytes: number;
  freeSpaceMarginBytes: number;
};

export class RecoveryRequiredError extends Error {
  readonly code = 'recovery_required';

  constructor(message: string) {
    super(`recovery_required: ${message}`);
    this.name = 'RecoveryRequiredError';
  }
}

export type PreparedStorage =
  | { mode: 'bootstrap'; manifest: null; replayAfter: string }
  | { mode: 'local'; manifest: SnapshotManifest | null; replayAfter: string }
  | { mode: 'restored'; manifest: SnapshotManifest; replayAfter: string };

export function databaseFilename(xmtpEnv: string, inboxId: string): string {
  return `xmtp-${xmtpEnv}-${inboxId}.db3`;
}

export function databasePath(dataDir: string, xmtpEnv: string, inboxId: string): string {
  return path.join(dataDir, databaseFilename(xmtpEnv, inboxId));
}

export function latestManifestKey(prefix: string): string {
  return `${prefix}/latest.json`;
}

export function bootstrapAttemptKey(prefix: string): string {
  return `${prefix}/bootstrap-attempt.json`;
}

export function primaryDatabaseObjectKey(manifest: SnapshotManifest): string {
  return manifest.database.parts[0]!.key;
}

export function databasePartCount(manifest: SnapshotManifest): number {
  return manifest.database.parts.length;
}

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function resolveSnapshotPolicy(policy: SnapshotReadPolicy): ResolvedSnapshotPolicy {
  if (Buffer.byteLength(policy.manifestSigningKey, 'utf8') < 32) {
    throw new Error('snapshot manifest signing key must be at least 32 bytes');
  }
  const maxBackupBytes = boundedInteger(
    'maxBackupBytes',
    policy.maxBackupBytes ?? DEFAULT_MAX_BACKUP_BYTES,
    1,
    5 * 1024 * 1024 * 1024,
  );
  const maxPartBytes = boundedInteger(
    'maxPartBytes',
    policy.maxPartBytes ?? MAX_SNAPSHOT_PART_BYTES,
    1,
    MAX_SNAPSHOT_PART_BYTES,
  );
  const freeSpaceMarginBytes = boundedInteger(
    'freeSpaceMarginBytes',
    policy.freeSpaceMarginBytes ?? DEFAULT_FREE_SPACE_MARGIN_BYTES,
    0,
    5 * 1024 * 1024 * 1024,
  );
  return {
    manifestSigningKey: policy.manifestSigningKey,
    maxBackupBytes,
    maxPartBytes,
    freeSpaceMarginBytes,
  };
}

export async function claimBootstrapAttempt(args: {
  store: ObjectStore;
  prefix: string;
  expectedInboxId: string;
  sourceBootId: string;
}): Promise<void> {
  const key = bootstrapAttemptKey(args.prefix);
  try {
    await args.store.getBytes(key, 128 * 1024);
    throw new RecoveryRequiredError(
      `a prior bootstrap attempt marker exists at ${key}; refusing to risk registering another installation`,
    );
  } catch (error) {
    if (!(error instanceof ObjectNotFoundError)) throw error;
  }

  const marker = Buffer.from(
    `${JSON.stringify(
      {
        version: 1,
        createdAt: new Date().toISOString(),
        expectedInboxId: args.expectedInboxId,
        sourceBootId: args.sourceBootId,
      },
      null,
      2,
    )}\n`,
  );
  const digest = sha256Bytes(marker);
  const claimed = await args.store.putBytesIfAbsent(key, marker, digest);
  if (!claimed) {
    throw new RecoveryRequiredError(
      `bootstrap attempt marker was claimed concurrently at ${key}; refusing registration`,
    );
  }
  const stored = await args.store.getBytes(key, 128 * 1024);
  if (sha256Bytes(stored) !== digest) {
    throw new RecoveryRequiredError('bootstrap attempt marker failed round-trip verification');
  }
}

export async function sha256File(filename: string): Promise<{ sha256: string; bytes: number }> {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filename);
    stream.on('data', (chunk: string | Buffer) => {
      const value = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += value.length;
      hash.update(value);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { sha256: hash.digest('hex'), bytes };
}

export function sha256Bytes(value: Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => {
        const entry = object[key];
        if (entry === undefined) throw new Error(`canonical JSON does not support undefined at ${key}`);
        return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
      })
      .join(',')}}`;
  }
  throw new Error(`canonical JSON does not support ${typeof value}`);
}

function unsignedManifest(manifest: SnapshotManifestV2): UnsignedSnapshotManifestV2 {
  const { signature: _signature, ...unsigned } = manifest;
  return unsigned;
}

function manifestHmac(manifest: UnsignedSnapshotManifestV2, signingKey: string): Buffer {
  return crypto
    .createHmac('sha256', signingKey)
    .update(MANIFEST_HMAC_DOMAIN)
    .update(canonicalJson(manifest))
    .digest();
}

export function signSnapshotManifest(
  manifest: UnsignedSnapshotManifestV2,
  signingKey: string,
): SnapshotManifestV2 {
  if (Buffer.byteLength(signingKey, 'utf8') < 32) {
    throw new Error('snapshot manifest signing key must be at least 32 bytes');
  }
  return snapshotManifestV2Schema.parse({
    ...manifest,
    signature: { algorithm: 'hmac-sha256', value: manifestHmac(manifest, signingKey).toString('hex') },
  });
}

export function verifySnapshotManifestSignature(
  manifest: SnapshotManifestV2,
  signingKey: string,
): boolean {
  if (Buffer.byteLength(signingKey, 'utf8') < 32) return false;
  const expected = manifestHmac(unsignedManifest(manifest), signingKey);
  const actual = Buffer.from(manifest.signature.value, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function serializeSnapshotManifest(manifest: SnapshotManifest): Uint8Array {
  return Buffer.from(canonicalJson(manifest), 'utf8');
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readPinnedInbox(dataDir: string): Promise<string | null> {
  try {
    const value = (await readFile(path.join(dataDir, PINNED_INBOX_FILENAME), 'utf8')).trim().toLowerCase();
    if (!inboxIdSchema.safeParse(value).success) {
      throw new RecoveryRequiredError(`${PINNED_INBOX_FILENAME} is invalid`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseManifest(
  bytes: Uint8Array,
  signingKey: string,
): SnapshotManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new RecoveryRequiredError('R2 latest manifest is not valid JSON');
  }
  const result = snapshotManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new RecoveryRequiredError(`R2 latest manifest is invalid: ${result.error.message}`);
  }
  const manifest = result.data;
  if (!verifySnapshotManifestSignature(manifest, signingKey)) {
    throw new RecoveryRequiredError('snapshot manifest HMAC signature verification failed');
  }
  return manifest;
}

function assertManifestMatches(args: {
  manifest: SnapshotManifest;
  prefix: string;
  xmtpEnv: 'production' | 'dev' | 'local';
  expectedInboxId: string | null;
  expectedInstallationId: string | null;
  maxBackupBytes: number;
  maxPartBytes: number;
}): void {
  const { manifest, prefix, xmtpEnv, expectedInboxId, expectedInstallationId } = args;
  if (manifest.xmtpEnv !== xmtpEnv) {
    throw new RecoveryRequiredError(
      `snapshot environment ${manifest.xmtpEnv} does not match configured ${xmtpEnv}`,
    );
  }
  if (expectedInboxId && manifest.inboxId !== expectedInboxId) {
    throw new RecoveryRequiredError(
      `snapshot inbox ${manifest.inboxId} does not match XMTP_EXPECTED_INBOX_ID ${expectedInboxId}`,
    );
  }
  if (expectedInstallationId && manifest.installationId !== expectedInstallationId) {
    throw new RecoveryRequiredError(
      `snapshot installation ${manifest.installationId} does not match XMTP_EXPECTED_INSTALLATION_ID ${expectedInstallationId}`,
    );
  }
  if (manifest.database.bytes > args.maxBackupBytes) {
    throw new RecoveryRequiredError(
      `snapshot database is ${manifest.database.bytes} bytes, exceeding configured total limit ${args.maxBackupBytes}`,
    );
  }

  const snapshotPrefix = `${prefix}/snapshots/${manifest.snapshotId}`;
  if (manifest.database.partSizeBytes > args.maxPartBytes) {
    throw new RecoveryRequiredError(
      `snapshot part size ${manifest.database.partSizeBytes} exceeds configured per-request limit ${args.maxPartBytes}`,
    );
  }
  if (manifest.pinnedInbox.key !== `${snapshotPrefix}/${PINNED_INBOX_FILENAME}`) {
    throw new RecoveryRequiredError('pinned inbox object key does not match the immutable snapshot layout');
  }
  if (manifest.pinnedInbox.bytes <= 0 || manifest.pinnedInbox.bytes > 4_096) {
    throw new RecoveryRequiredError('pinned inbox object has an invalid size');
  }

  let expectedOffset = 0;
  for (const [position, part] of manifest.database.parts.entries()) {
    const expectedKey = `${snapshotPrefix}/database/part-${String(position).padStart(6, '0')}-${part.sha256}.bin`;
    if (part.index !== position || part.offset !== expectedOffset || part.key !== expectedKey) {
      throw new RecoveryRequiredError(`snapshot database part ${position} has invalid order, offset, or key`);
    }
    if (part.bytes > manifest.database.partSizeBytes || part.bytes > args.maxPartBytes) {
      throw new RecoveryRequiredError(`snapshot database part ${position} exceeds its declared limit`);
    }
    const isLast = position === manifest.database.parts.length - 1;
    if (!isLast && part.bytes !== manifest.database.partSizeBytes) {
      throw new RecoveryRequiredError(`snapshot database part ${position} is short before the final part`);
    }
    expectedOffset += part.bytes;
  }
  const expectedPartCount = Math.ceil(manifest.database.bytes / manifest.database.partSizeBytes);
  if (
    expectedOffset !== manifest.database.bytes ||
    manifest.database.parts.length !== expectedPartCount
  ) {
    throw new RecoveryRequiredError('snapshot database parts do not exactly cover the declared database size');
  }
}

export async function readLatestManifest(args: {
  store: ObjectStore;
  prefix: string;
  xmtpEnv: 'production' | 'dev' | 'local';
  expectedInboxId: string | null;
  expectedInstallationId: string | null;
} & SnapshotReadPolicy): Promise<SnapshotManifest | null> {
  const policy = resolveSnapshotPolicy(args);
  let bytes: Uint8Array;
  try {
    bytes = await args.store.getBytes(latestManifestKey(args.prefix), MAX_MANIFEST_BYTES);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) return null;
    throw error;
  }
  const manifest = parseManifest(
    bytes,
    policy.manifestSigningKey,
  );
  assertManifestMatches({
    ...args,
    manifest,
    maxBackupBytes: policy.maxBackupBytes,
    maxPartBytes: policy.maxPartBytes,
  });
  return manifest;
}

async function fsyncFile(filename: string): Promise<void> {
  const handle = await open(filename, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function assertSufficientFreeSpace(args: {
  operation: string;
  availableBytes: bigint;
  requiredBytes: number;
}): void {
  if (!Number.isSafeInteger(args.requiredBytes) || args.requiredBytes < 0) {
    throw new Error('required free-space byte count is invalid');
  }
  const required = BigInt(args.requiredBytes);
  if (args.availableBytes < required) {
    throw new RecoveryRequiredError(
      `${args.operation} requires ${required} free bytes but only ${args.availableBytes} are available`,
    );
  }
}

async function assertLocalFreeSpace(
  target: string,
  requiredBytes: number,
  operation: string,
): Promise<void> {
  let availableBytes: bigint;
  try {
    const details = await statfs(target, { bigint: true });
    availableBytes = details.bavail * details.bsize;
  } catch (error) {
    throw new RecoveryRequiredError(
      `unable to verify free space before ${operation}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertSufficientFreeSpace({ operation, availableBytes, requiredBytes });
}

function safeByteSum(left: number, right: number, description: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new RecoveryRequiredError(`${description} byte count overflows`);
  return sum;
}

async function writeExactly(
  handle: Awaited<ReturnType<typeof open>>,
  value: Uint8Array,
  fileOffset: number,
): Promise<void> {
  let written = 0;
  while (written < value.byteLength) {
    const result = await handle.write(value, written, value.byteLength - written, fileOffset + written);
    if (result.bytesWritten <= 0) throw new RecoveryRequiredError('restored database write made no progress');
    written += result.bytesWritten;
  }
}

async function restoreChunkedDatabase(args: {
  store: ObjectStore;
  manifest: SnapshotManifestV2;
  stagedDb: string;
  maxPartBytes: number;
}): Promise<void> {
  const handle = await open(args.stagedDb, 'wx', 0o600);
  const databaseHash = crypto.createHash('sha256');
  let databaseBytes = 0;
  try {
    for (const part of args.manifest.database.parts) {
      let bytes: Uint8Array;
      try {
        bytes = await args.store.getBytes(part.key, Math.min(part.bytes, args.maxPartBytes));
      } catch (error) {
        if (error instanceof ObjectNotFoundError) {
          throw new RecoveryRequiredError(`snapshot database part is missing: ${part.key}`);
        }
        throw error;
      }
      const digest = sha256Bytes(bytes);
      if (bytes.byteLength !== part.bytes || digest !== part.sha256) {
        throw new RecoveryRequiredError(
          `snapshot database part ${part.index} failed SHA-256/size verification`,
        );
      }
      await writeExactly(handle, bytes, part.offset);
      databaseHash.update(bytes);
      databaseBytes += bytes.byteLength;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }

  const digest = databaseHash.digest('hex');
  if (
    databaseBytes !== args.manifest.database.bytes ||
    digest !== args.manifest.database.sha256
  ) {
    throw new RecoveryRequiredError('concatenated XMTP database failed SHA-256/size verification');
  }
}

export async function restoreSnapshot(args: {
  store: ObjectStore;
  prefix: string;
  dataDir: string;
  xmtpEnv: 'production' | 'dev' | 'local';
  expectedInboxId: string | null;
  expectedInstallationId: string | null;
  manifest?: SnapshotManifest;
} & SnapshotReadPolicy): Promise<SnapshotManifest> {
  const policy = resolveSnapshotPolicy(args);
  const manifest = args.manifest ?? (await readLatestManifest(args));
  if (!manifest) throw new RecoveryRequiredError(`no snapshot exists at ${latestManifestKey(args.prefix)}`);
  assertManifestMatches({
    ...args,
    manifest,
    maxBackupBytes: policy.maxBackupBytes,
    maxPartBytes: policy.maxPartBytes,
  });

  await mkdir(args.dataDir, { recursive: true, mode: 0o700 });
  const destinationDb = databasePath(args.dataDir, args.xmtpEnv, manifest.inboxId);
  const destinationPin = path.join(args.dataDir, PINNED_INBOX_FILENAME);
  if ((await pathExists(destinationDb)) || (await pathExists(destinationPin))) {
    throw new RecoveryRequiredError('restore destination is not empty; refusing to overwrite local XMTP state');
  }
  await assertLocalFreeSpace(
    args.dataDir,
    safeByteSum(manifest.database.bytes, policy.freeSpaceMarginBytes, 'restore preflight'),
    'XMTP snapshot restore',
  );

  const staging = await mkdtemp(path.join(args.dataDir, '.restore-'));
  const stagedDb = path.join(staging, 'xmtp.db3');
  const stagedPin = path.join(staging, PINNED_INBOX_FILENAME);
  try {
    await restoreChunkedDatabase({
      store: args.store,
      manifest,
      stagedDb,
      maxPartBytes: policy.maxPartBytes,
    });

    let pinBytes: Uint8Array;
    try {
      pinBytes = await args.store.getBytes(manifest.pinnedInbox.key, 4_096);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        throw new RecoveryRequiredError('pinned inbox snapshot object is missing');
      }
      throw error;
    }
    if (
      sha256Bytes(pinBytes) !== manifest.pinnedInbox.sha256 ||
      pinBytes.byteLength !== manifest.pinnedInbox.bytes
    ) {
      throw new RecoveryRequiredError('pinned inbox object failed SHA-256/size verification');
    }
    const restoredPin = Buffer.from(pinBytes).toString('utf8').trim().toLowerCase();
    if (restoredPin !== manifest.inboxId || (args.expectedInboxId && restoredPin !== args.expectedInboxId)) {
      throw new RecoveryRequiredError('restored pinned inbox does not match manifest/configuration');
    }
    await writeFile(stagedPin, `${restoredPin}\n`, { mode: 0o600, flag: 'wx' });
    await fsyncFile(stagedDb);
    await fsyncFile(stagedPin);

    // Rename the DB first. A crash before the pin rename leaves a detectable partial state;
    // startup will fail closed rather than constructing an XMTP client.
    await rename(stagedDb, destinationDb);
    await rename(stagedPin, destinationPin);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function prepareStorage(args: {
  store: ObjectStore;
  prefix: string;
  dataDir: string;
  xmtpEnv: 'production' | 'dev' | 'local';
  expectedInboxId: string | null;
  expectedInstallationId: string | null;
  allowNewInstallation: boolean;
} & SnapshotReadPolicy): Promise<PreparedStorage> {
  await mkdir(args.dataDir, { recursive: true, mode: 0o700 });
  const entries = await readdir(args.dataDir);
  const xmtpDatabases = entries.filter((entry) => /^xmtp-(production|dev|local)-[0-9a-f]{64}\.db3$/i.test(entry));
  const pinnedInbox = await readPinnedInbox(args.dataDir);

  if (xmtpDatabases.length > 1) {
    throw new RecoveryRequiredError(`multiple local XMTP databases found: ${xmtpDatabases.join(', ')}`);
  }

  if (pinnedInbox && args.expectedInboxId && pinnedInbox !== args.expectedInboxId) {
    throw new RecoveryRequiredError(
      `local ${PINNED_INBOX_FILENAME} ${pinnedInbox} does not match XMTP_EXPECTED_INBOX_ID ${args.expectedInboxId}`,
    );
  }

  const expectedLocalDb = pinnedInbox
    ? databaseFilename(args.xmtpEnv, pinnedInbox)
    : args.expectedInboxId
      ? databaseFilename(args.xmtpEnv, args.expectedInboxId)
      : null;
  const hasExpectedDb = expectedLocalDb ? xmtpDatabases.includes(expectedLocalDb) : false;

  if (pinnedInbox || xmtpDatabases.length > 0) {
    if (!pinnedInbox || !hasExpectedDb || xmtpDatabases.length !== 1) {
      throw new RecoveryRequiredError(
        `partial or mismatched local state (pin=${pinnedInbox ?? 'missing'}, databases=${xmtpDatabases.join(',') || 'missing'})`,
      );
    }
    const manifest = await readLatestManifest(args);
    if (!manifest && !args.allowNewInstallation) {
      throw new RecoveryRequiredError(
        'local XMTP DB/pin exist but no authenticated D1-anchored snapshot lineage is available',
      );
    }
    return {
      mode: 'local',
      manifest,
      replayAfter: manifest?.replayAfter ?? new Date(0).toISOString(),
    };
  }

  const manifest = await readLatestManifest(args);
  if (manifest) {
    const restored = await restoreSnapshot({ ...args, manifest });
    return { mode: 'restored', manifest: restored, replayAfter: restored.replayAfter };
  }

  if (!args.allowNewInstallation) {
    throw new RecoveryRequiredError(
      'local XMTP DB/pin are absent and no verified R2 snapshot exists; refusing to construct Client or register an installation',
    );
  }

  return { mode: 'bootstrap', manifest: null, replayAfter: new Date(0).toISOString() };
}

async function assertDatabaseQuiesced(dbPath: string): Promise<void> {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${dbPath}${suffix}`;
    try {
      const details = await stat(sidecar);
      if (details.size > 0) {
        throw new RecoveryRequiredError(
          `XMTP child exited but ${path.basename(sidecar)} still contains ${details.size} bytes; refusing unsafe snapshot`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

function sameClosedFile(
  before: Awaited<ReturnType<typeof stat>>,
  after: Awaited<ReturnType<typeof stat>>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  offset: number,
): Promise<Buffer> {
  const value = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(value, read, length - read, offset + read);
    if (result.bytesRead <= 0) {
      throw new RecoveryRequiredError('quiesced database ended before its declared size');
    }
    read += result.bytesRead;
  }
  return value;
}

async function putImmutableVerified(args: {
  store: ObjectStore;
  key: string;
  value: Uint8Array;
  sha256: string;
  maxReadbackBytes: number;
  description: string;
}): Promise<void> {
  let created: boolean;
  try {
    created = await args.store.putBytesIfAbsent(args.key, args.value, args.sha256);
  } catch (error) {
    if (error instanceof ObjectStoreRequestError && error.status >= 400 && error.status < 500) {
      throw new RecoveryRequiredError(`${args.description} upload was permanently rejected: ${error.message}`);
    }
    throw error;
  }
  if (!created) {
    throw new RecoveryRequiredError(`immutable ${args.description} already exists: ${args.key}`);
  }
  let remote: Uint8Array;
  try {
    remote = await args.store.getBytes(args.key, args.maxReadbackBytes);
  } catch (error) {
    if (
      error instanceof ObjectNotFoundError
      || (error instanceof ObjectStoreRequestError && error.status >= 400 && error.status < 500)
    ) {
      throw new RecoveryRequiredError(`${args.description} readback was rejected or missing: ${error.message}`);
    }
    throw error;
  }
  if (remote.byteLength !== args.value.byteLength || sha256Bytes(remote) !== args.sha256) {
    throw new RecoveryRequiredError(`${args.description} failed round-trip SHA-256/size verification`);
  }
}

export async function createQuiescedSnapshot(args: {
  store: ObjectStore;
  prefix: string;
  dataDir: string;
  xmtpEnv: 'production' | 'dev' | 'local';
  expectedInboxId: string | null;
  expectedInstallationId: string | null;
  currentInboxId: string;
  installationId: string;
  sourceBootId: string;
  reason: string;
  replayAfter: string;
  replayWatermark: string | null;
  manifestSigningKey: string;
  partSizeBytes?: number;
  maxBackupBytes?: number;
  freeSpaceMarginBytes?: number;
}): Promise<SnapshotManifestV2> {
  const partSizeBytes = boundedInteger(
    'partSizeBytes',
    args.partSizeBytes ?? DEFAULT_SNAPSHOT_PART_BYTES,
    1,
    MAX_SNAPSHOT_PART_BYTES,
  );
  const policy = resolveSnapshotPolicy({
    manifestSigningKey: args.manifestSigningKey,
    maxBackupBytes: args.maxBackupBytes,
    maxPartBytes: partSizeBytes,
    freeSpaceMarginBytes: args.freeSpaceMarginBytes,
  });
  const inboxId = args.currentInboxId.toLowerCase();
  if (args.expectedInboxId && inboxId !== args.expectedInboxId) {
    throw new RecoveryRequiredError('current XMTP inbox does not match XMTP_EXPECTED_INBOX_ID');
  }
  if (args.expectedInstallationId && args.installationId !== args.expectedInstallationId) {
    throw new RecoveryRequiredError('current XMTP installation does not match XMTP_EXPECTED_INSTALLATION_ID');
  }

  const pinPath = path.join(args.dataDir, PINNED_INBOX_FILENAME);
  const pin = await readPinnedInbox(args.dataDir);
  if (pin !== inboxId) throw new RecoveryRequiredError('pinned inbox file does not match current XMTP client inbox');
  const pinDetailsBefore = await stat(pinPath);
  if (!pinDetailsBefore.isFile() || pinDetailsBefore.size <= 0 || pinDetailsBefore.size > 4_096) {
    throw new RecoveryRequiredError(`${PINNED_INBOX_FILENAME} is missing, empty, or oversized`);
  }

  const dbPath = databasePath(args.dataDir, args.xmtpEnv, inboxId);
  const dbDetailsBefore = await stat(dbPath);
  if (!dbDetailsBefore.isFile() || dbDetailsBefore.size === 0) {
    throw new RecoveryRequiredError(`XMTP database is missing or empty: ${dbPath}`);
  }
  if (dbDetailsBefore.size > policy.maxBackupBytes) {
    throw new RecoveryRequiredError(
      `XMTP database is ${dbDetailsBefore.size} bytes, exceeding configured total limit ${policy.maxBackupBytes}`,
    );
  }
  await assertDatabaseQuiesced(dbPath);
  await assertLocalFreeSpace(
    args.dataDir,
    policy.freeSpaceMarginBytes,
    'quiesced XMTP snapshot',
  );

  const snapshotId = crypto.randomUUID();
  const snapshotPrefix = `${args.prefix}/snapshots/${snapshotId}`;
  const databaseHash = crypto.createHash('sha256');
  const parts: SnapshotManifestV2['database']['parts'] = [];
  const handle = await open(dbPath, 'r');
  try {
    let offset = 0;
    let index = 0;
    while (offset < dbDetailsBefore.size) {
      const bytes = Math.min(partSizeBytes, dbDetailsBefore.size - offset);
      const value = await readExactly(handle, bytes, offset);
      const digest = sha256Bytes(value);
      const key = `${snapshotPrefix}/database/part-${String(index).padStart(6, '0')}-${digest}.bin`;
      await putImmutableVerified({
        store: args.store,
        key,
        value,
        sha256: digest,
        maxReadbackBytes: partSizeBytes,
        description: `database part ${index}`,
      });
      databaseHash.update(value);
      parts.push({ index, offset, key, sha256: digest, bytes });
      offset += bytes;
      index += 1;
      if (index > MAX_SNAPSHOT_PARTS) {
        throw new RecoveryRequiredError(`snapshot requires more than ${MAX_SNAPSHOT_PARTS} database parts`);
      }
    }
  } finally {
    await handle.close();
  }

  const dbDetailsAfter = await stat(dbPath);
  await assertDatabaseQuiesced(dbPath);
  if (!sameClosedFile(dbDetailsBefore, dbDetailsAfter)) {
    throw new RecoveryRequiredError('XMTP database changed while its quiesced snapshot was read');
  }

  const pinBytes = await readFile(pinPath);
  const snapshotPin = Buffer.from(pinBytes).toString('utf8').trim().toLowerCase();
  const pinDetailsAfter = await stat(pinPath);
  if (snapshotPin !== inboxId || !sameClosedFile(pinDetailsBefore, pinDetailsAfter)) {
    throw new RecoveryRequiredError('pinned inbox file changed or mismatched during quiesced snapshot');
  }
  const pinDigest = sha256Bytes(pinBytes);
  const pinnedInboxKey = `${snapshotPrefix}/${PINNED_INBOX_FILENAME}`;
  await putImmutableVerified({
    store: args.store,
    key: pinnedInboxKey,
    value: pinBytes,
    sha256: pinDigest,
    maxReadbackBytes: 4_096,
    description: 'pinned inbox object',
  });

  const unsignedManifest: UnsignedSnapshotManifestV2 = {
    version: 2,
    snapshotId,
    createdAt: new Date().toISOString(),
    xmtpEnv: args.xmtpEnv,
    inboxId,
    installationId: args.installationId,
    database: {
      sha256: databaseHash.digest('hex'),
      bytes: dbDetailsBefore.size,
      partSizeBytes,
      parts,
    },
    pinnedInbox: { key: pinnedInboxKey, sha256: pinDigest, bytes: pinBytes.byteLength },
    sourceBootId: args.sourceBootId,
    sourceDeploymentId: process.env.CLOUDFLARE_DEPLOYMENT_ID ?? null,
    reason: args.reason,
    replayAfter: args.replayAfter,
    replayWatermark: args.replayWatermark,
  };
  const manifest = snapshotManifestSchema.parse(
    signSnapshotManifest(unsignedManifest, policy.manifestSigningKey),
  ) as SnapshotManifestV2;
  assertManifestMatches({
    manifest,
    prefix: args.prefix,
    xmtpEnv: args.xmtpEnv,
    expectedInboxId: args.expectedInboxId,
    expectedInstallationId: args.expectedInstallationId,
    maxBackupBytes: policy.maxBackupBytes,
    maxPartBytes: partSizeBytes,
  });

  const manifestBytes = serializeSnapshotManifest(manifest);
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new RecoveryRequiredError(`snapshot manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  const manifestSha = sha256Bytes(manifestBytes);
  const immutableManifestKey = `${snapshotPrefix}/manifest.json`;
  await putImmutableVerified({
    store: args.store,
    key: immutableManifestKey,
    value: manifestBytes,
    sha256: manifestSha,
    maxReadbackBytes: MAX_MANIFEST_BYTES,
    description: 'immutable manifest',
  });
  const immutableManifest = parseManifest(
    await args.store.getBytes(immutableManifestKey, MAX_MANIFEST_BYTES),
    policy.manifestSigningKey,
  );
  if (immutableManifest.snapshotId !== snapshotId) {
    throw new RecoveryRequiredError('immutable manifest identity failed round-trip verification');
  }

  // Publish latest last through the Worker. Its D1 freshness anchor rejects a
  // rollback/replay; this readback must match the newly anchored pointer.
  let latest: Uint8Array;
  try {
    await args.store.putBytes(latestManifestKey(args.prefix), manifestBytes, manifestSha);
    latest = await args.store.getBytes(latestManifestKey(args.prefix), MAX_MANIFEST_BYTES);
  } catch (error) {
    if (
      error instanceof ObjectNotFoundError
      || (error instanceof ObjectStoreRequestError && error.status >= 400 && error.status < 500)
    ) {
      throw new RecoveryRequiredError(`latest snapshot publication/readback was rejected: ${error.message}`);
    }
    throw error;
  }
  const parsedLatest = parseManifest(latest, policy.manifestSigningKey);
  if (parsedLatest.snapshotId !== snapshotId || sha256Bytes(latest) !== manifestSha) {
    throw new RecoveryRequiredError('latest snapshot pointer failed freshness/readback verification');
  }
  return manifest;
}
