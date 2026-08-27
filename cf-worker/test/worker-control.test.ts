import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayEnv } from '../src/bindings';

const containers = vi.hoisted(() => ({ getContainer: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('@cloudflare/containers', () => ({
  ...containers,
  Container: class {
    renewActivityTimeout(): void {}
  },
  ContainerProxy: class {},
}));

import worker from '../src/worker';

const EXPECTED_INBOX = 'a'.repeat(64);

describe('production Container recovery controls', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires the pinned inbox ID in addition to admin auth and instance confirmation', async () => {
    const env = makeEnv();
    const response = await worker.fetch(controlRequest({
      confirm: 'xmtp-mx-relay-production',
    }), env);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'expected_inbox_confirmation_required',
    });
    expect(containers.getContainer).not.toHaveBeenCalled();
  });

  it('runs a gated restart only when all confirmations match', async () => {
    const relay = {
      stop: vi.fn().mockResolvedValue(undefined),
      startAndWaitForPorts: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockResolvedValue({ status: 'healthy' }),
      fetch: vi.fn().mockResolvedValue(Response.json({ ok: true, inboxId: EXPECTED_INBOX })),
    };
    containers.getContainer.mockReturnValue(relay);
    const response = await worker.fetch(controlRequest({
      confirm: 'xmtp-mx-relay-production',
      expectedInboxId: EXPECTED_INBOX,
    }), makeEnv());

    expect(response.status).toBe(200);
    expect(relay.stop).toHaveBeenCalledWith('SIGTERM');
    expect(relay.startAndWaitForPorts).toHaveBeenCalled();
  });

  it('keeps manual backup private and requires exact singleton confirmation', async () => {
    const unauthorized = backupRequest({
      confirm: 'xmtp-mx-relay-production',
      reason: 'pre-cutover',
    });
    unauthorized.headers.delete('authorization');
    expect((await worker.fetch(unauthorized, makeEnv())).status).toBe(401);

    const missingConfirmation = await worker.fetch(
      backupRequest({ reason: 'pre-cutover' }),
      makeEnv(),
    );
    expect(missingConfirmation.status).toBe(409);
    expect(containers.getContainer).not.toHaveBeenCalled();
  });

  it('requires a non-empty bounded reason for a manual backup', async () => {
    const response = await worker.fetch(backupRequest({
      confirm: 'xmtp-mx-relay-production',
      reason: '   ',
    }), makeEnv());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'backup_reason_required' });
    expect(containers.getContainer).not.toHaveBeenCalled();
  });

  it('proxies a confirmed backup to the private Container endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      snapshotId: 'snapshot-id',
      inboxId: EXPECTED_INBOX,
      installationId: 'installation-id',
    }));
    containers.getContainer.mockReturnValue({
      getState: vi.fn().mockResolvedValue({ status: 'healthy' }),
      fetch,
    });

    const response = await worker.fetch(backupRequest({
      confirm: 'xmtp-mx-relay-production',
      reason: 'pre-cutover',
    }), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, snapshotId: 'snapshot-id' });
    const forwarded = fetch.mock.calls[0]?.[0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/internal/v1/admin/backup');
    expect(forwarded.headers.get('authorization')).toBe('Bearer container-secret');
    expect(await forwarded.json()).toEqual({ reason: 'pre-cutover' });
  });
});

describe('paused recovery object import', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unauthenticated imports', async () => {
    const request = recoveryPutRequest();
    request.headers.delete('authorization');
    const response = await worker.fetch(request, makeEnv());
    expect(response.status).toBe(401);
    expect(containers.getContainer).not.toHaveBeenCalled();
  });

  it('rejects imports unless the watchdog is durably paused', async () => {
    const response = await worker.fetch(recoveryPutRequest(), makeEnv({ paused: false }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'recovery_import_requires_watchdog_pause',
    });
    expect(containers.getContainer).not.toHaveBeenCalled();
  });

  it('rejects imports unless the explicit recovery-import gate is enabled', async () => {
    const response = await worker.fetch(recoveryPutRequest(), makeEnv({ importEnabled: false }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'recovery_import_disabled' });
    expect(containers.getContainer).not.toHaveBeenCalled();
  });

  it('rejects imports while the stable Container is running', async () => {
    containers.getContainer.mockReturnValue({
      getState: vi.fn().mockResolvedValue({ status: 'healthy' }),
    });
    const response = await worker.fetch(recoveryPutRequest(), makeEnv());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'recovery_import_requires_stopped_container',
    });
  });

  it('imports a checksummed object only while explicitly enabled, paused, and stopped', async () => {
    containers.getContainer.mockReturnValue({
      getState: vi.fn().mockResolvedValue({ status: 'stopped' }),
    });
    const put = vi.fn().mockResolvedValue({ size: 6, etag: 'seed-etag' });
    const env = makeEnv({ put });
    const response = await worker.fetch(recoveryPutRequest(), env);
    expect(response.status).toBe(200);
    expect(put).toHaveBeenCalledWith(
      'xmtp-mx-relay-production/xmtp/bootstrap-attempt.json',
      expect.any(ArrayBuffer),
      expect.objectContaining({
        customMetadata: {
          sha256: 'ed5b8120601641c516d02ed9dc643a59648524248d5e2af877da39ea253c723e',
        },
      }),
    );
  });

  it('requires an exact production-name confirmation header on PUT', async () => {
    const request = recoveryPutRequest();
    request.headers.delete('x-recovery-confirm');
    const response = await worker.fetch(request, makeEnv());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'recovery_confirmation_required' });
    expect(containers.getContainer).not.toHaveBeenCalled();
  });
});

function controlRequest(body: Record<string, unknown>): Request {
  return new Request('https://edge.example/internal/v1/container/restart', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function backupRequest(body: Record<string, unknown>): Request {
  return new Request('https://edge.example/internal/v1/container/backup', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function recoveryPutRequest(): Request {
  return new Request(
    'https://edge.example/internal/v1/admin/recovery/objects/'
      + 'xmtp-mx-relay-production%2Fxmtp%2Fbootstrap-attempt.json',
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer recovery-secret',
        'content-length': '6',
        'content-type': 'application/octet-stream',
        'if-none-match': '*',
        'x-object-sha256': 'ed5b8120601641c516d02ed9dc643a59648524248d5e2af877da39ea253c723e',
        'x-recovery-confirm': 'xmtp-mx-relay-production',
      },
      body: 'marker',
    },
  );
}

function makeEnv(options: {
  paused?: boolean;
  put?: ReturnType<typeof vi.fn>;
  importEnabled?: boolean;
} = {}): RelayEnv {
  return {
    RELAY_ADMIN_TOKEN: 'admin-secret',
    RECOVERY_ADMIN_TOKEN: 'recovery-secret',
    CONTAINER_SHARED_SECRET: 'container-secret',
    CONTAINER_INSTANCE_NAME: 'xmtp-mx-relay-production',
    XMTP_ENV: 'production',
    RECOVERY_DRILL_ENABLED: 'true',
    RECOVERY_IMPORT_ENABLED: options.importEnabled === false ? 'false' : 'true',
    XMTP_EXPECTED_INBOX_ID: EXPECTED_INBOX,
    XMTP_RELAY: {},
    XMTP_R2_PREFIX: 'xmtp-mx-relay-production/xmtp',
    MAX_XMTP_BACKUP_PART_BYTES: String(16 * 1024 * 1024),
    XMTP_STATE_BUCKET: { put: options.put ?? vi.fn() },
    RELAY_DB: {
      prepare: vi.fn().mockReturnValue({
        bind() {
          return this;
        },
        first: vi.fn().mockResolvedValue({
          value: JSON.stringify({ paused: options.paused ?? true }),
        }),
      }),
    },
  } as unknown as RelayEnv;
}
