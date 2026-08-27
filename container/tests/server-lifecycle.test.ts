import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createLogger } from '../src/log.js';
import { closeServer, createHttpServer, listen } from '../src/server.js';
import { RuntimeState } from '../src/state.js';
import type { XmtpSupervisor } from '../src/supervisor.js';

async function withServer(
  state: RuntimeState,
  operation: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const supervisor = { state } as XmtpSupervisor;
  const server = createHttpServer({
    supervisor,
    sharedSecret: 's'.repeat(32),
    maxRequestBodyBytes: 1_024,
    log: createLogger('silent'),
  });
  await listen(server, 0);
  try {
    const address = server.address() as AddressInfo;
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

test('livez remains live while fatal health and readiness fail closed', async () => {
  const state = new RuntimeState(null, null, null, 60_000);
  state.phase = 'fatal';
  state.lastError = 'recovery_required: operator action required';

  await withServer(state, async (baseUrl) => {
    const [liveness, health, readiness] = await Promise.all([
      fetch(`${baseUrl}/livez`),
      fetch(`${baseUrl}/healthz`),
      fetch(`${baseUrl}/readyz`),
    ]);

    assert.equal(liveness.status, 200);
    assert.deepEqual(await liveness.json(), {
      ok: true,
      live: true,
      bootId: state.bootId,
      startedAt: state.startedAt,
    });
    assert.equal(health.status, 503);
    assert.equal((await health.json() as { ok: boolean }).ok, false);
    assert.equal(readiness.status, 503);
  });
});

test('healthz remains successful for a live transient degraded state', async () => {
  const state = new RuntimeState(null, null, null, 60_000);
  state.phase = 'degraded';

  await withServer(state, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      ready: false,
      phase: 'degraded',
      bootId: state.bootId,
      startedAt: state.startedAt,
    });
  });
});
