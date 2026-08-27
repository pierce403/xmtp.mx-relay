import { Container, ContainerProxy } from '@cloudflare/containers';
import { env as workerEnv } from 'cloudflare:workers';
import { requireContainerAuth } from './auth';
import type { RelayEnv } from './bindings';
import { getSnapshotAnchor, reserveSnapshotAnchor } from './db';
import { handleXmtpEventRequest } from './events';
import { envInteger, errorMessage, structuredLog } from './runtime';

export { ContainerProxy };

export class XmtpRelayContainer extends Container<RelayEnv> {
  defaultPort = 8080;
  requiredPorts = [8080];
  // Liveness stays 200 for a fail-closed recovery-required process so the
  // platform does not restart-loop it; readiness/health expose the fatal state.
  pingEndpoint = 'localhost/livez';
  sleepAfter = '24h';
  enableInternet = true;
  envVars = containerEnvironment(workerEnv);

  override async onActivityExpired(): Promise<void> {
    // Intentionally do not stop: the XMTP stream is an always-on daemon. The
    // Container runtime renews the timer after this hook returns.
    structuredLog('info', 'container.activity_timeout_renewed');
    this.renewActivityTimeout();
  }

  override onStop(params: { exitCode?: number; reason: string }): void {
    structuredLog('error', 'container.stopped', {
      exitCode: params.exitCode ?? null,
      reason: params.reason,
    });
  }
}

XmtpRelayContainer.outboundByHost = {
  'xmtp-edge.internal': async (request: Request, env: RelayEnv): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== '/internal/v1/xmtp/events') {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    return handleXmtpEventRequest(request, env);
  },
  'xmtp-r2.internal': async (request: Request, env: RelayEnv): Promise<Response> => {
    return handleR2ObjectRequest(request, env);
  },
};

export async function handleR2ObjectRequest(
  request: Request,
  env: RelayEnv,
  trustedRecovery?: { objectKey: string },
): Promise<Response> {
  if (!trustedRecovery) {
    const unauthorized = requireContainerAuth(request, env);
    if (unauthorized) return unauthorized;
  }

  const url = new URL(request.url);
  const prefix = '/v1/objects/';
  if (!trustedRecovery && !url.pathname.startsWith(prefix)) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  let key: string;
  try {
    key = trustedRecovery?.objectKey ?? decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return Response.json({ ok: false, error: 'invalid_key' }, { status: 400 });
  }
  if (!isAllowedR2Key(key, env)) {
    structuredLog('warn', 'r2.object.denied', { key, method: request.method });
    return Response.json({ ok: false, error: 'invalid_key' }, { status: 403 });
  }

  if (request.method === 'GET') {
    if (isLatestManifestKey(key, env)) return handleLatestManifestGet(key, env);
    try {
      return verifiedObjectResponse(await readVerifiedStoredObject(key, env));
    } catch (error) {
      return storedObjectErrorResponse(error);
    }
  }

  if (request.method === 'PUT') {
    if (!request.body) return Response.json({ ok: false, error: 'missing_body' }, { status: 400 });
    const sha256 = request.headers.get('x-object-sha256')?.trim().toLowerCase() ?? '';
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      return Response.json({ ok: false, error: 'invalid_sha256' }, { status: 400 });
    }
    const maxBytes = backupPartMaxBytes(env);
    const rawContentLength = request.headers.get('content-length')?.trim() ?? '';
    if (!/^\d+$/.test(rawContentLength)) {
      return Response.json({ ok: false, error: 'content_length_required' }, { status: 411 });
    }
    const contentLength = Number(rawContentLength);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxBytes) {
      return Response.json({ ok: false, error: 'object_too_large' }, { status: 413 });
    }
    const ifNoneMatch = request.headers.get('if-none-match')?.trim() ?? '';
    if (ifNoneMatch && ifNoneMatch !== '*') {
      return Response.json({ ok: false, error: 'unsupported_precondition' }, { status: 400 });
    }

    let body: ArrayBuffer;
    try {
      body = await readExactBody(request.body, contentLength, maxBytes);
    } catch (error) {
      const code = error instanceof BodyReadError ? error.code : 'body_read_failed';
      const status = code === 'object_too_large' ? 413 : 400;
      return Response.json({ ok: false, error: code }, { status });
    }
    const actualSha256 = await sha256Hex(body);
    if (actualSha256 !== sha256) {
      structuredLog('error', 'r2.object.checksum_mismatch', { key, contentLength });
      return Response.json({ ok: false, error: 'checksum_mismatch' }, { status: 400 });
    }
    if (isLatestManifestKey(key, env)) {
      return publishLatestManifest(key, body, actualSha256, env);
    }
    // Every object except the D1-anchored latest pointer is immutable. Enforce
    // create-only semantics at the bridge instead of trusting each authenticated
    // caller to remember the precondition.
    if (ifNoneMatch !== '*') {
      return Response.json({ ok: false, error: 'create_only_precondition_required' }, { status: 428 });
    }

    try {
      const putOptions: R2PutOptions = {
        httpMetadata: { contentType: 'application/octet-stream' },
        customMetadata: { sha256 },
      };
      putOptions.onlyIf = { etagDoesNotMatch: '*' };
      const stored = await env.XMTP_STATE_BUCKET.put(key, body, putOptions);
      if (!stored) {
        structuredLog('warn', 'r2.object.precondition_failed', { key });
        return Response.json({ ok: false, error: 'precondition_failed' }, { status: 412 });
      }
      if (stored.size !== contentLength) {
        structuredLog('error', 'r2.object.size_mismatch', {
          key,
          declaredSize: contentLength,
          storedSize: stored.size,
        });
        return Response.json({ ok: false, error: 'stored_size_mismatch' }, { status: 500 });
      }
      structuredLog('info', 'r2.object.put', { key, etag: stored.etag, contentLength });
      return Response.json({ ok: true, key, etag: stored.etag });
    } catch (error) {
      structuredLog('error', 'r2.object.put_failed', { key, error: errorMessage(error) });
      return Response.json({ ok: false, error: 'object_put_failed' }, { status: 500 });
    }
  }

  return Response.json({ ok: false, error: 'method_not_allowed' }, {
    status: 405,
    headers: { allow: 'GET, PUT' },
  });
}

function isAllowedR2Key(key: string, env: RelayEnv): boolean {
  const allowedPrefix = (env.XMTP_R2_PREFIX?.trim() || 'xmtp-mx-relay-production/xmtp')
    .replace(/^\/+|\/+$/g, '');
  return Boolean(
    key
      && key.length <= 1_024
      && !key.includes('\0')
      && !key.startsWith('/')
      && !key.split('/').some((segment) => segment === '.' || segment === '..')
      && (key === allowedPrefix || key.startsWith(`${allowedPrefix}/`)),
  );
}

type VerifiedStoredObject = {
  key: string;
  body: ArrayBuffer;
  sha256: string;
  etag: string;
  contentType: string | null;
};

class StoredObjectError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

async function readVerifiedStoredObject(
  key: string,
  env: RelayEnv,
): Promise<VerifiedStoredObject> {
  let object: R2ObjectBody | null;
  try {
    object = await env.XMTP_STATE_BUCKET.get(key);
  } catch (error) {
    structuredLog('error', 'r2.object.get_failed', { key, error: errorMessage(error) });
    throw new StoredObjectError('object_read_failed', 503);
  }
  if (!object) throw new StoredObjectError('not_found', 404);
  const maxPartBytes = backupPartMaxBytes(env);
  if (object.size > maxPartBytes) {
    structuredLog('error', 'r2.object.oversize_read_blocked', {
      key,
      size: object.size,
      maxPartBytes,
    });
    throw new StoredObjectError('object_too_large', 413);
  }

  let body: ArrayBuffer;
  try {
    body = await object.arrayBuffer();
  } catch (error) {
    structuredLog('error', 'r2.object.body_read_failed', { key, error: errorMessage(error) });
    throw new StoredObjectError('object_read_failed', 503);
  }
  if (body.byteLength !== object.size) {
    throw new StoredObjectError('stored_size_mismatch', 409);
  }
  const actualSha256 = await sha256Hex(body);
  const storedSha256 = object.customMetadata?.sha256?.trim().toLowerCase() ?? '';
  if (storedSha256 && (!/^[a-f0-9]{64}$/.test(storedSha256) || storedSha256 !== actualSha256)) {
    structuredLog('error', 'r2.object.integrity_mismatch', { key });
    throw new StoredObjectError('object_integrity_mismatch', 409);
  }
  return {
    key,
    body,
    sha256: actualSha256,
    etag: object.httpEtag,
    contentType: object.httpMetadata?.contentType ?? null,
  };
}

function verifiedObjectResponse(object: VerifiedStoredObject): Response {
  const headers = new Headers({
    etag: object.etag,
    'content-length': String(object.body.byteLength),
    'cache-control': 'no-store',
    'x-object-sha256': object.sha256,
  });
  if (object.contentType) headers.set('content-type', object.contentType);
  return new Response(object.body, { status: 200, headers });
}

function storedObjectErrorResponse(error: unknown): Response {
  if (error instanceof StoredObjectError) {
    if (error.status === 404) return new Response(null, { status: 404 });
    return Response.json({ ok: false, error: error.code }, { status: error.status });
  }
  structuredLog('error', 'r2.object.unexpected_read_failure', { error: errorMessage(error) });
  return Response.json({ ok: false, error: 'object_read_failed' }, { status: 503 });
}

async function publishLatestManifest(
  latestKey: string,
  body: ArrayBuffer,
  sha256: string,
  env: RelayEnv,
): Promise<Response> {
  const identity = await verifyLatestManifest(body, env);
  if (!identity) {
    return Response.json({ ok: false, error: 'invalid_latest_manifest' }, { status: 400 });
  }
  const immutableKey = immutableManifestKey(identity.snapshotId, env);
  let immutable: VerifiedStoredObject;
  try {
    immutable = await readVerifiedStoredObject(immutableKey, env);
  } catch (error) {
    if (error instanceof StoredObjectError && error.status === 404) {
      return Response.json({ ok: false, error: 'immutable_manifest_missing' }, { status: 409 });
    }
    return storedObjectErrorResponse(error);
  }
  if (
    immutable.sha256 !== sha256
    || immutable.body.byteLength !== body.byteLength
    || !bytesEqual(immutable.body, body)
  ) {
    structuredLog('error', 'r2.latest.immutable_manifest_mismatch', {
      latestKey,
      immutableKey,
      snapshotId: identity.snapshotId,
    });
    return Response.json({ ok: false, error: 'immutable_manifest_mismatch' }, { status: 409 });
  }

  try {
    const reserved = await reserveSnapshotAnchor(env, {
      objectKey: latestKey,
      ...identity,
      sha256,
    });
    if (!reserved) {
      structuredLog('error', 'r2.latest.rollback_put_blocked', {
        latestKey,
        snapshotId: identity.snapshotId,
        createdAt: identity.createdAt,
      });
      return Response.json({ ok: false, error: 'stale_snapshot_pointer' }, { status: 409 });
    }
  } catch (error) {
    structuredLog('error', 'r2.latest.anchor_write_failed', {
      latestKey,
      error: errorMessage(error),
    });
    return Response.json({ ok: false, error: 'snapshot_anchor_unavailable' }, { status: 503 });
  }

  structuredLog('info', 'r2.latest.anchor_published', {
    latestKey,
    immutableKey,
    snapshotId: identity.snapshotId,
  });
  // D1 is the authoritative mutable pointer. Do not write an R2 latest object:
  // that would create an unavoidable cross-system commit race.
  return Response.json({
    ok: true,
    key: latestKey,
    etag: immutable.etag,
    anchored: true,
  });
}

async function handleLatestManifestGet(latestKey: string, env: RelayEnv): Promise<Response> {
  let anchor: Awaited<ReturnType<typeof getSnapshotAnchor>>;
  try {
    anchor = await getSnapshotAnchor(env, latestKey);
  } catch (error) {
    structuredLog('error', 'r2.latest.anchor_read_failed', {
      latestKey,
      error: errorMessage(error),
    });
    return Response.json({ ok: false, error: 'snapshot_anchor_unavailable' }, { status: 503 });
  }

  if (anchor) {
    let immutable: VerifiedStoredObject;
    try {
      immutable = await readVerifiedStoredObject(
        immutableManifestKey(anchor.snapshot_id, env),
        env,
      );
    } catch (error) {
      if (error instanceof StoredObjectError && error.status === 404) {
        return Response.json({ ok: false, error: 'anchored_manifest_missing' }, { status: 409 });
      }
      return storedObjectErrorResponse(error);
    }
    const identity = await verifyLatestManifest(immutable.body, env);
    if (
      !identity
      || identity.snapshotId !== anchor.snapshot_id
      || identity.createdAt !== anchor.created_at
      || immutable.sha256 !== anchor.sha256
    ) {
      structuredLog('error', 'r2.latest.anchored_manifest_mismatch', {
        latestKey,
        anchoredSnapshotId: anchor.snapshot_id,
      });
      return Response.json({ ok: false, error: 'snapshot_anchor_mismatch' }, { status: 409 });
    }
    return verifiedObjectResponse(immutable);
  }
  // The paused, admin-authenticated recovery uploader establishes the first
  // anchor by PUTting latest only after the immutable manifest exists. Never
  // reconstruct a missing D1 anchor from mutable R2 state: loss of the anchor
  // must fail closed instead of making a stale but validly signed snapshot
  // authoritative again.
  structuredLog('error', 'r2.latest.anchor_missing', { latestKey });
  // 404 is the Container object-store contract for a truly absent snapshot.
  // Normal production still fails closed because ALLOW_NEW=false; only the
  // separately confirmed first-ever bootstrap may proceed from absence.
  return Response.json({ ok: false, error: 'snapshot_anchor_missing' }, { status: 404 });
}

function immutableManifestKey(snapshotId: string, env: RelayEnv): string {
  const prefix = (env.XMTP_R2_PREFIX?.trim() || 'xmtp-mx-relay-production/xmtp')
    .replace(/^\/+|\/+$/g, '');
  return `${prefix}/snapshots/${snapshotId}/manifest.json`;
}

function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function containerEnvironment(env: RelayEnv): Record<string, string> {
  const allowNewInstallation = env.XMTP_ALLOW_NEW_INSTALLATION === 'true';
  const values: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    PORT: '8080',
    DATA_DIR: '/data',
    XMTP_ENV: env.XMTP_ENV || 'production',
    XMTP_BOT_KEY: required(env.XMTP_BOT_KEY, 'XMTP_BOT_KEY'),
    XMTP_DEAN_ADDRESS: required(env.XMTP_DEAN_ADDRESS, 'XMTP_DEAN_ADDRESS'),
    XMTP_EXPECTED_INBOX_ID: required(env.XMTP_EXPECTED_INBOX_ID, 'XMTP_EXPECTED_INBOX_ID'),
    XMTP_EXPECTED_INSTALLATION_ID: allowNewInstallation
      ? env.XMTP_EXPECTED_INSTALLATION_ID
      : required(env.XMTP_EXPECTED_INSTALLATION_ID, 'XMTP_EXPECTED_INSTALLATION_ID'),
    XMTP_ALLOW_NEW_INSTALLATION: allowNewInstallation ? 'true' : 'false',
    XMTP_BOOTSTRAP_CONFIRM: allowNewInstallation ? env.XMTP_BOOTSTRAP_CONFIRM : undefined,
    XMTP_EMERGENCY_REVOKE_INSTALLATIONS: 'false',
    CONTAINER_SHARED_SECRET: required(env.CONTAINER_SHARED_SECRET, 'CONTAINER_SHARED_SECRET'),
    XMTP_SNAPSHOT_SIGNING_KEY: required(
      env.XMTP_SNAPSHOT_SIGNING_KEY,
      'XMTP_SNAPSHOT_SIGNING_KEY',
    ),
    EDGE_INTERNAL_URL: 'http://xmtp-edge.internal',
    R2_INTERNAL_BASE_URL: 'http://xmtp-r2.internal',
    XMTP_R2_PREFIX: env.XMTP_R2_PREFIX || 'xmtp-mx-relay-production/xmtp',
    XMTP_BACKUP_INTERVAL_SECONDS: env.XMTP_BACKUP_INTERVAL_SECONDS || '3600',
    XMTP_BACKUP_MAX_STALENESS_SECONDS: env.XMTP_BACKUP_MAX_STALENESS_SECONDS || '7200',
    XMTP_FREE_SPACE_MARGIN_BYTES: env.XMTP_FREE_SPACE_MARGIN_BYTES || String(64 * 1024 * 1024),
    XMTP_MAX_BACKUP_BYTES: env.MAX_XMTP_BACKUP_BYTES || String(1024 * 1024 * 1024),
    XMTP_BACKUP_PART_BYTES: env.MAX_XMTP_BACKUP_PART_BYTES || String(16 * 1024 * 1024),
    MAX_INTERNAL_REQUEST_BYTES: env.MAX_INTERNAL_REQUEST_BYTES || String(512 * 1024),
    MAX_XMTP_CONTENT_BYTES: env.MAX_RELAY_BODY_BYTES || String(256 * 1024),
    ETH_RPC_URL: env.ETH_RPC_URL,
    LOG_LEVEL: env.LOG_LEVEL || 'info',
  };
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function backupPartMaxBytes(env: RelayEnv): number {
  return envInteger(env.MAX_XMTP_BACKUP_PART_BYTES, 16 * 1024 * 1024, {
    min: 1024 * 1024,
    max: 32 * 1024 * 1024,
  });
}

type LatestManifestIdentity = {
  snapshotId: string;
  createdAt: string;
  createdAtMs: number;
};

function isLatestManifestKey(key: string, env: RelayEnv): boolean {
  const prefix = (env.XMTP_R2_PREFIX?.trim() || 'xmtp-mx-relay-production/xmtp')
    .replace(/^\/+|\/+$/g, '');
  return key === `${prefix}/latest.json`;
}

async function verifyLatestManifest(
  body: ArrayBuffer,
  env: RelayEnv,
): Promise<LatestManifestIdentity | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(body));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const manifest = parsed as Record<string, unknown>;
  const snapshotId = manifest.snapshotId;
  const createdAt = manifest.createdAt;
  const signature = manifest.signature;
  if (
    manifest.version !== 2
    || typeof snapshotId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(snapshotId)
    || typeof createdAt !== 'string'
    || !signature
    || typeof signature !== 'object'
    || Array.isArray(signature)
  ) return null;
  const signatureRecord = signature as Record<string, unknown>;
  if (
    signatureRecord.algorithm !== 'hmac-sha256'
    || typeof signatureRecord.value !== 'string'
    || !/^[a-f0-9]{64}$/.test(signatureRecord.value)
  ) return null;
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isSafeInteger(createdAtMs)) return null;

  const unsigned = { ...manifest };
  delete unsigned.signature;
  let canonical: string;
  try {
    canonical = canonicalJson(unsigned);
  } catch {
    return null;
  }
  const signingKey = env.XMTP_SNAPSHOT_SIGNING_KEY?.trim() ?? '';
  if (new TextEncoder().encode(signingKey).byteLength < 32) return null;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signedBytes = new TextEncoder().encode(
    `xmtp.mx/xmtp-snapshot-manifest/v2\0${canonical}`,
  );
  const expected = await crypto.subtle.sign('HMAC', cryptoKey, signedBytes);
  const expectedHex = [...new Uint8Array(expected)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (!constantTimeHexEqual(expectedHex, signatureRecord.value)) return null;
  return { snapshotId, createdAt, createdAtMs };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error('unsupported canonical JSON value');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

class BodyReadError extends Error {
  constructor(readonly code: 'content_length_mismatch' | 'object_too_large') {
    super(code);
  }
}

async function readExactBody(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyReadError('object_too_large');
      if (total > expectedBytes) throw new BodyReadError('content_length_mismatch');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (total !== expectedBytes) throw new BodyReadError('content_length_mismatch');

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw new Error(`Missing required Container binding value: ${name}`);
  return trimmed;
}
