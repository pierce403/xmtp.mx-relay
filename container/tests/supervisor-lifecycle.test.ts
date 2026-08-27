import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import type { ChildToParentMessage } from '../src/protocol.js';
import { RecoveryRequiredError, type SnapshotManifest } from '../src/snapshot.js';
import { XmtpSupervisor } from '../src/supervisor.js';

const inboxId = 'a'.repeat(64);

function makeSupervisor(onProcessRestartRequired: (error: unknown) => void): XmtpSupervisor {
  const config = loadConfig({
    PORT: '8080',
    DATA_DIR: '/tmp/xmtp-mx-supervisor-lifecycle-test',
    XMTP_ENV: 'production',
    XMTP_BOT_KEY: `0x${'1'.repeat(64)}`,
    XMTP_DEAN_ADDRESS: `0x${'2'.repeat(40)}`,
    XMTP_EXPECTED_INBOX_ID: inboxId,
    XMTP_EXPECTED_INSTALLATION_ID: 'installation-1',
    CONTAINER_SHARED_SECRET: 's'.repeat(32),
    XMTP_SNAPSHOT_SIGNING_KEY: 'k'.repeat(32),
  });
  return new XmtpSupervisor(
    config,
    createLogger('silent'),
    { onProcessRestartRequired },
  );
}

function replaceBackup(
  supervisor: XmtpSupervisor,
  operation: () => Promise<SnapshotManifest>,
): void {
  const internals = supervisor as unknown as {
    backupExclusive: (reason: string) => Promise<SnapshotManifest>;
  };
  internals.backupExclusive = operation;
}

test('a transient backup lifecycle failure requests one host process restart', async () => {
  const restartErrors: unknown[] = [];
  const supervisor = makeSupervisor((error) => restartErrors.push(error));
  const failure = new Error('temporary R2 outage');
  replaceBackup(supervisor, async () => { throw failure; });

  await assert.rejects(supervisor.backup('periodic'), failure);
  await assert.rejects(supervisor.backup('periodic'), failure);

  assert.deepEqual(restartErrors, [failure]);
  assert.equal(supervisor.state.phase, 'fatal');
  assert.equal(supervisor.state.isReady(), false);
  assert.equal(supervisor.internalStatus().processRestartRequested, true);
  assert.equal(supervisor.internalStatus().recoveryRequired, false);
});

test('a recovery-required backup failure stays fail-closed without requesting restart', async () => {
  const restartErrors: unknown[] = [];
  const supervisor = makeSupervisor((error) => restartErrors.push(error));
  const failure = new RecoveryRequiredError('restored installation mismatch');
  replaceBackup(supervisor, async () => { throw failure; });

  await assert.rejects(supervisor.backup('periodic'), failure);

  assert.deepEqual(restartErrors, []);
  assert.equal(supervisor.state.phase, 'fatal');
  assert.equal(supervisor.state.isReady(), false);
  assert.equal(supervisor.internalStatus().processRestartRequested, false);
  assert.equal(supervisor.internalStatus().recoveryRequired, true);
});

test('a child-declared recovery failure enters the no-restart operator hold', () => {
  const restartErrors: unknown[] = [];
  const supervisor = makeSupervisor((error) => restartErrors.push(error));
  const internals = supervisor as unknown as {
    onChildMessage: (child: ChildProcess, message: ChildToParentMessage) => void;
  };

  internals.onChildMessage(null as unknown as ChildProcess, {
    type: 'fatal',
    error: 'recovery_required: pinned inbox mismatch',
    recoveryRequired: true,
  });

  assert.deepEqual(restartErrors, []);
  assert.equal(supervisor.state.phase, 'fatal');
  assert.equal(supervisor.internalStatus().recoveryRequired, true);
  assert.match(supervisor.state.lastError ?? '', /pinned inbox mismatch/);
});

test('a failed live stream is forced out of service so the child restart path runs', async () => {
  const restartErrors: unknown[] = [];
  const supervisor = makeSupervisor((error) => restartErrors.push(error));
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const child = {
    pid: 42,
    kill(signal?: NodeJS.Signals | number) {
      signals.push(signal);
      return true;
    },
  } as ChildProcess;
  const internals = supervisor as unknown as {
    child: ChildProcess | null;
    applyChildStatus: (message: Extract<ChildToParentMessage, { type: 'status' }>) => void;
    onChildExit: (
      child: ChildProcess,
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void;
  };
  internals.child = child;
  supervisor.state.ready = true;
  supervisor.state.streamConnected = true;

  internals.applyChildStatus({
    type: 'status',
    event: 'xmtp_stream_failed',
    at: new Date().toISOString(),
  });

  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(supervisor.state.phase, 'degraded');
  assert.equal(supervisor.state.isReady(), false);

  internals.onChildExit(child, 0, null);
  assert.equal(supervisor.state.streamRestarts, 1);
  assert.deepEqual(restartErrors, []);
  await supervisor.shutdown();
});

test('every safely processed source-message event advances the durable replay overlap', () => {
  const supervisor = makeSupervisor(() => undefined);
  const processedAt = '2026-08-26T12:34:56.789Z';
  const internals = supervisor as unknown as {
    applyChildStatus: (message: Extract<ChildToParentMessage, { type: 'status' }>) => void;
  };

  internals.applyChildStatus({
    type: 'status',
    event: 'source_message_processed',
    at: '2026-08-26T12:35:00.000Z',
    detail: processedAt,
  });

  const status = supervisor.internalStatus();
  assert.equal(status.replayWatermark, processedAt);
  assert.equal(
    status.replayAfter,
    new Date(Date.parse(processedAt) - supervisor.config.replayOverlapMs).toISOString(),
  );
});
