import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayEnv } from '../src/bindings';

type TestAnchor = {
  object_key: string;
  snapshot_id: string;
  created_at: string;
  created_at_ms: number;
  sha256: string;
  updated_at: string;
};

const anchorDb = vi.hoisted(() => ({
  current: null as TestAnchor | null,
  getSnapshotAnchor: vi.fn(),
  reserveSnapshotAnchor: vi.fn(),
}));

vi.mock('../src/db', () => anchorDb);
vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    renewActivityTimeout(): void {}
  },
  ContainerProxy: class {},
}));

import { handleR2ObjectRequest } from '../src/container';

const SHA256 = 'ed5b8120601641c516d02ed9dc643a59648524248d5e2af877da39ea253c723e';

describe('private R2 object bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    anchorDb.current = null;
    anchorDb.getSnapshotAnchor.mockImplementation(async () => anchorDb.current);
    anchorDb.reserveSnapshotAnchor.mockImplementation(async (_env, input) => {
      const current = anchorDb.current;
      if (
        current
        && !(current.snapshot_id === input.snapshotId && current.sha256 === input.sha256)
        && input.createdAtMs <= current.created_at_ms
      ) return false;
      anchorDb.current = {
        object_key: input.objectKey,
        snapshot_id: input.snapshotId,
        created_at: input.createdAt,
        created_at_ms: input.createdAtMs,
        sha256: input.sha256,
        updated_at: input.createdAt,
      };
      return true;
    });
  });

  it('passes bootstrap marker create-only semantics to R2', async () => {
    const put = vi.fn().mockResolvedValue({ size: 6, etag: 'etag-1' });
    const env = makeEnv(put);
    const response = await handleR2ObjectRequest(putRequest({ ifNoneMatch: '*' }), env);

    expect(response.status).toBe(200);
    expect(put).toHaveBeenCalledWith(
      'xmtp-mx-relay-production/xmtp/bootstrap-attempt.json',
      expect.anything(),
      expect.objectContaining({
        onlyIf: { etagDoesNotMatch: '*' },
        customMetadata: { sha256: SHA256 },
      }),
    );
  });

  it('returns 412 when a bootstrap marker already exists', async () => {
    const response = await handleR2ObjectRequest(
      putRequest({ ifNoneMatch: '*' }),
      makeEnv(vi.fn().mockResolvedValue(null)),
    );
    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({ ok: false, error: 'precondition_failed' });
  });

  it('refuses to overwrite a non-latest object even for an authenticated caller', async () => {
    const put = vi.fn();
    const response = await handleR2ObjectRequest(putRequest(), makeEnv(put));

    expect(response.status).toBe(428);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'create_only_precondition_required',
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects snapshot PUTs without a trustworthy Content-Length', async () => {
    const request = new Request(
      'http://xmtp-r2.internal/v1/objects/xmtp-mx-relay-production%2Fxmtp%2Fsnapshot.tar',
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer container-secret',
          'x-object-sha256': SHA256,
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('snapshot'));
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' },
    );
    const response = await handleR2ObjectRequest(request, makeEnv(vi.fn()));
    expect(response.status).toBe(411);
  });

  it('rejects an object above the independent 32 MiB per-part hard cap', async () => {
    const request = putRequest();
    request.headers.set('content-length', String(32 * 1024 * 1024 + 1));
    const put = vi.fn();
    const response = await handleR2ObjectRequest(request, {
      ...makeEnv(put),
      MAX_XMTP_BACKUP_PART_BYTES: String(32 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects a declared checksum that does not match the buffered part', async () => {
    const request = putRequest();
    request.headers.set('x-object-sha256', 'a'.repeat(64));
    const put = vi.fn();
    const response = await handleR2ObjectRequest(request, makeEnv(put));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'checksum_mismatch' });
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects a body whose actual byte length differs from Content-Length', async () => {
    const request = putRequest();
    request.headers.set('content-length', '5');
    const put = vi.fn();
    const response = await handleR2ObjectRequest(request, makeEnv(put));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'content_length_mismatch' });
    expect(put).not.toHaveBeenCalled();
  });

  it('computes GET integrity for an initial Wrangler seed without R2 custom metadata', async () => {
    const body = new TextEncoder().encode('marker').buffer as ArrayBuffer;
    const env = {
      ...makeEnv(vi.fn()),
      XMTP_STATE_BUCKET: {
        get: vi.fn().mockResolvedValue({
          size: body.byteLength,
          httpEtag: 'seed-etag',
          customMetadata: {},
          httpMetadata: { contentType: 'application/octet-stream' },
          arrayBuffer: async () => body,
        }),
      },
    } as unknown as RelayEnv;
    const response = await handleR2ObjectRequest(new Request(
      'http://xmtp-r2.internal/v1/objects/xmtp-mx-relay-production%2Fxmtp%2Fseed.bin',
      { headers: { authorization: 'Bearer container-secret' } },
    ), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-object-sha256')).toBe(SHA256);
  });

  it('publishes latest through D1, is idempotent, and rejects an older signed replay', async () => {
    const store = objectStoreEnv();
    const newest = await latestArtifact(
      '22222222-2222-4222-8222-222222222222',
      '2026-08-27T03:00:00.000Z',
      store.env.XMTP_SNAPSHOT_SIGNING_KEY,
    );
    stageImmutable(store.objects, newest);

    const accepted = await handleR2ObjectRequest(newest.putRequest(), store.env);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, anchored: true });
    const idempotent = await handleR2ObjectRequest(newest.putRequest(), store.env);
    expect(idempotent.status).toBe(200);

    const older = await latestArtifact(
      '11111111-1111-4111-8111-111111111111',
      '2026-08-27T02:00:00.000Z',
      store.env.XMTP_SNAPSHOT_SIGNING_KEY,
    );
    stageImmutable(store.objects, older);
    const rejected = await handleR2ObjectRequest(older.putRequest(), store.env);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ ok: false, error: 'stale_snapshot_pointer' });
    expect(store.put).not.toHaveBeenCalled();
    expect(anchorDb.current?.snapshot_id).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('does not advance D1 when latest publication fails', async () => {
    const store = objectStoreEnv();
    const artifact = await latestArtifact(
      '33333333-3333-4333-8333-333333333333',
      '2026-08-27T04:00:00.000Z',
      store.env.XMTP_SNAPSHOT_SIGNING_KEY,
    );
    stageImmutable(store.objects, artifact);
    anchorDb.reserveSnapshotAnchor.mockRejectedValueOnce(new Error('D1 unavailable'));

    const failed = await handleR2ObjectRequest(artifact.putRequest(), store.env);
    expect(failed.status).toBe(503);
    expect(anchorDb.current).toBeNull();
    expect(store.put).not.toHaveBeenCalled();

    const retry = await handleR2ObjectRequest(artifact.putRequest(), store.env);
    expect(retry.status).toBe(200);
    expect(anchorDb.current?.snapshot_id).toBe(artifact.snapshotId);
  });

  it('rejects a missing or corrupt immutable manifest before anchoring', async () => {
    const store = objectStoreEnv();
    const artifact = await latestArtifact(
      '44444444-4444-4444-8444-444444444444',
      '2026-08-27T05:00:00.000Z',
      store.env.XMTP_SNAPSHOT_SIGNING_KEY,
    );

    const missing = await handleR2ObjectRequest(artifact.putRequest(), store.env);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ ok: false, error: 'immutable_manifest_missing' });
    expect(anchorDb.current).toBeNull();

    store.objects.set(artifact.immutableKey, {
      body: new TextEncoder().encode('corrupt').buffer as ArrayBuffer,
      sha256: artifact.sha256,
    });
    const corrupt = await handleR2ObjectRequest(artifact.putRequest(), store.env);
    expect(corrupt.status).toBe(409);
    expect(await corrupt.json()).toEqual({ ok: false, error: 'object_integrity_mismatch' });
    expect(anchorDb.current).toBeNull();
  });

  it('fails closed when D1 anchor is missing even if mutable and immutable manifests exist', async () => {
    const store = objectStoreEnv();
    const artifact = await latestArtifact(
      '55555555-5555-4555-8555-555555555555',
      '2026-08-27T06:00:00.000Z',
      store.env.XMTP_SNAPSHOT_SIGNING_KEY,
    );
    stageImmutable(store.objects, artifact);
    store.objects.set('xmtp-mx-relay-production/xmtp/latest.json', {
      body: artifact.body,
      sha256: artifact.sha256,
    });

    const response = await handleR2ObjectRequest(latestGetRequest(), store.env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'snapshot_anchor_missing' });
    expect(anchorDb.current).toBeNull();
  });

  it('serves the D1-anchored immutable manifest even if mutable R2 latest is rolled back', async () => {
    const store = objectStoreEnv();
    const newest = await latestArtifact(
      '66666666-6666-4666-8666-666666666666',
      '2026-08-27T07:00:00.000Z',
      store.env.XMTP_SNAPSHOT_SIGNING_KEY,
    );
    const older = await latestArtifact(
      '55555555-5555-4555-8555-555555555555',
      '2026-08-27T06:00:00.000Z',
      store.env.XMTP_SNAPSHOT_SIGNING_KEY,
    );
    stageImmutable(store.objects, newest);
    store.objects.set('xmtp-mx-relay-production/xmtp/latest.json', {
      body: older.body,
      sha256: older.sha256,
    });
    anchorDb.current = {
      object_key: 'xmtp-mx-relay-production/xmtp/latest.json',
      snapshot_id: newest.snapshotId,
      created_at: newest.createdAt,
      created_at_ms: Date.parse(newest.createdAt),
      sha256: newest.sha256,
      updated_at: newest.createdAt,
    };

    const response = await handleR2ObjectRequest(latestGetRequest(), store.env);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-object-sha256')).toBe(newest.sha256);
    expect(await response.arrayBuffer()).toEqual(newest.body);
  });
});

function putRequest({ ifNoneMatch }: { ifNoneMatch?: string } = {}): Request {
  const headers = new Headers({
    authorization: 'Bearer container-secret',
    'content-type': 'application/octet-stream',
    'content-length': '6',
    'x-object-sha256': SHA256,
  });
  if (ifNoneMatch) headers.set('if-none-match', ifNoneMatch);
  return new Request(
    'http://xmtp-r2.internal/v1/objects/xmtp-mx-relay-production%2Fxmtp%2Fbootstrap-attempt.json',
    { method: 'PUT', headers, body: 'marker' },
  );
}

function makeEnv(put: ReturnType<typeof vi.fn>): RelayEnv {
  return {
    CONTAINER_SHARED_SECRET: 'container-secret',
    XMTP_R2_PREFIX: 'xmtp-mx-relay-production/xmtp',
    MAX_XMTP_BACKUP_BYTES: String(1024 * 1024 * 1024),
    MAX_XMTP_BACKUP_PART_BYTES: String(16 * 1024 * 1024),
    XMTP_STATE_BUCKET: { put },
  } as unknown as RelayEnv;
}

type LatestArtifact = {
  snapshotId: string;
  createdAt: string;
  body: ArrayBuffer;
  sha256: string;
  immutableKey: string;
  putRequest(): Request;
};

async function latestArtifact(
  snapshotId: string,
  createdAt: string,
  signingKey: string,
): Promise<LatestArtifact> {
  const unsigned = { version: 2, snapshotId, createdAt };
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(
      `xmtp.mx/xmtp-snapshot-manifest/v2\0${canonicalJson(unsigned)}`,
    ),
  );
  const signature = [...new Uint8Array(signatureBytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const body = canonicalJson({
    ...unsigned,
    signature: { algorithm: 'hmac-sha256', value: signature },
  });
  const bytes = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return {
    snapshotId,
    createdAt,
    body: bytes.buffer as ArrayBuffer,
    sha256,
    immutableKey: `xmtp-mx-relay-production/xmtp/snapshots/${snapshotId}/manifest.json`,
    putRequest() {
      return new Request(
        'http://xmtp-r2.internal/v1/objects/xmtp-mx-relay-production%2Fxmtp%2Flatest.json',
        {
          method: 'PUT',
          headers: {
            authorization: 'Bearer container-secret',
            'content-type': 'application/json',
            'content-length': String(bytes.byteLength),
            'x-object-sha256': sha256,
          },
          body,
        },
      );
    },
  };
}

function latestGetRequest(): Request {
  return new Request(
    'http://xmtp-r2.internal/v1/objects/xmtp-mx-relay-production%2Fxmtp%2Flatest.json',
    { headers: { authorization: 'Bearer container-secret' } },
  );
}

function stageImmutable(
  objects: Map<string, { body: ArrayBuffer; sha256: string }>,
  artifact: LatestArtifact,
): void {
  objects.set(artifact.immutableKey, { body: artifact.body, sha256: artifact.sha256 });
}

function objectStoreEnv(): {
  env: RelayEnv;
  objects: Map<string, { body: ArrayBuffer; sha256: string }>;
  put: ReturnType<typeof vi.fn>;
} {
  const objects = new Map<string, { body: ArrayBuffer; sha256: string }>();
  const put = vi.fn();
  const get = vi.fn().mockImplementation(async (key: string) => {
    const entry = objects.get(key);
    if (!entry) return null;
    return {
      size: entry.body.byteLength,
      httpEtag: `etag:${key}`,
      customMetadata: { sha256: entry.sha256 },
      httpMetadata: { contentType: 'application/json' },
      arrayBuffer: async () => entry.body.slice(0),
    };
  });
  const env = {
    ...makeEnv(put),
    XMTP_SNAPSHOT_SIGNING_KEY: 'snapshot-signing-key-that-is-at-least-32-bytes',
    XMTP_STATE_BUCKET: { put, get },
  } as unknown as RelayEnv;
  return { env, objects, put };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}
