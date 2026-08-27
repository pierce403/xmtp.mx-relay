import crypto from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type pino from 'pino';
import type { ContainerConfig } from './config.js';
import { HttpObjectStore, type ObjectStore } from './object-store.js';
import type {
  ChildToParentMessage,
  DeliveryRequest,
  ParentToChildMessage,
} from './protocol.js';
import {
  claimBootstrapAttempt,
  createQuiescedSnapshot,
  databasePartCount,
  MAX_SNAPSHOT_PART_BYTES,
  prepareStorage,
  primaryDatabaseObjectKey,
  RecoveryRequiredError,
  type PreparedStorage,
  type SnapshotManifest,
} from './snapshot.js';
import { RuntimeState } from './state.js';
import { startupFailureDisposition } from './startup-policy.js';

type ChildReady = Extract<ChildToParentMessage, { type: 'ready' }>;

type PendingDelivery = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type DeliveryCacheEntry = {
  fingerprint: string;
  promise: Promise<{ jobId: string; xmtpMessageId: string; deduplicated: boolean }>;
  createdAt: number;
};

export type SupervisorLifecycleHooks = {
  onProcessRestartRequired: (error: unknown) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class XmtpSupervisor {
  readonly state: RuntimeState;
  readonly store: ObjectStore;

  private child: ChildProcess | null = null;
  private expectedManifest: SnapshotManifest | null = null;
  private replayAfter = new Date(0).toISOString();
  private replayWatermark: string | null = null;
  private childReadyResolve: ((ready: ChildReady) => void) | null = null;
  private childReadyReject: ((error: Error) => void) | null = null;
  private childExitResolve: ((result: { code: number | null; signal: NodeJS.Signals | null }) => void) | null = null;
  private pendingDeliveries = new Map<string, PendingDelivery>();
  private deliveryCache = new Map<string, DeliveryCacheEntry>();
  private acceptingDeliveries = false;
  private intentionalChildStop = false;
  private shuttingDown = false;
  private backupTimer: NodeJS.Timeout | null = null;
  private lifecycleTail: Promise<unknown> = Promise.resolve();
  private restartTimer: NodeJS.Timeout | null = null;
  private fatalChildExitTimer: NodeJS.Timeout | null = null;
  private processRestartRequested = false;
  private recoveryRequired = false;

  constructor(
    readonly config: ContainerConfig,
    private readonly log: pino.Logger,
    private readonly lifecycleHooks: SupervisorLifecycleHooks,
    store?: ObjectStore,
  ) {
    this.state = new RuntimeState(
      config.xmtpExpectedInboxId,
      config.xmtpExpectedInstallationId,
      config.bootGeneration,
      config.backupMaxStalenessMs,
    );
    this.store =
      store ??
      new HttpObjectStore(
        config.r2InternalBaseUrl,
        config.containerSharedSecret,
        180_000,
        MAX_SNAPSHOT_PART_BYTES,
      );
  }

  async start(): Promise<void> {
    this.state.phase = 'restoring';
    const prepared = await prepareStorage({
      store: this.store,
      prefix: this.config.r2Prefix,
      dataDir: this.config.dataDir,
      xmtpEnv: this.config.xmtpEnv,
      expectedInboxId: this.config.xmtpExpectedInboxId,
      expectedInstallationId: this.config.xmtpExpectedInstallationId,
      allowNewInstallation: this.config.allowNewInstallation,
      manifestSigningKey: this.config.snapshotSigningKey,
      maxBackupBytes: this.config.maxBackupBytes,
      maxPartBytes: this.config.backupPartBytes,
      freeSpaceMarginBytes: this.config.freeSpaceMarginBytes,
    });
    this.applyPreparedStorage(prepared);
    if (prepared.mode === 'bootstrap') {
      if (!this.config.xmtpExpectedInboxId) {
        throw new RecoveryRequiredError('bootstrap requires XMTP_EXPECTED_INBOX_ID');
      }
      await claimBootstrapAttempt({
        store: this.store,
        prefix: this.config.r2Prefix,
        expectedInboxId: this.config.xmtpExpectedInboxId,
        sourceBootId: this.state.bootId,
      });
      this.log.warn(
        { alert: 'XMTP_BOOTSTRAP_ATTEMPT_CLAIMED' },
        'xmtp.bootstrap_attempt_claimed',
      );
    }
    await this.startChild(this.replayAfter, false);

    // Sync mutates the XMTP DB. Take a new quiesced snapshot before announcing
    // readiness so every boot proves stop/snapshot/restart recovery works.
    await this.backup('startup');
    this.schedulePeriodicBackup();
  }

  private applyPreparedStorage(prepared: PreparedStorage): void {
    this.expectedManifest = prepared.manifest;
    this.replayAfter = prepared.replayAfter;
    this.replayWatermark = prepared.manifest?.replayWatermark ?? null;
    if (prepared.manifest) {
      this.state.recovery = {
        manifestKey: `${this.config.r2Prefix}/latest.json`,
        databaseKey: primaryDatabaseObjectKey(prepared.manifest),
        databasePartCount: databasePartCount(prepared.manifest),
        sha256: prepared.manifest.database.sha256,
        createdAt: prepared.manifest.createdAt,
        restoredAt: prepared.mode === 'restored' ? new Date().toISOString() : null,
      };
      this.state.lastBackupAt = prepared.manifest.createdAt;
    }
    this.log.info(
      {
        mode: prepared.mode,
        snapshotId: prepared.manifest?.snapshotId ?? null,
        inboxId: prepared.manifest?.inboxId ?? this.config.xmtpExpectedInboxId,
      },
      'xmtp.storage_prepared',
    );
  }

  private childModuleUrl(): URL {
    const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    return new URL(`./xmtp-child${extension}`, import.meta.url);
  }

  private async startChild(replayAfter: string, allowDeliveries = true): Promise<ChildReady> {
    if (this.shuttingDown) throw new Error('supervisor_shutting_down');
    if (this.child) throw new Error('XMTP child is already running');
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    this.state.phase = 'creating_xmtp_client';
    this.state.ready = false;
    this.state.streamConnected = false;
    this.acceptingDeliveries = false;
    this.intentionalChildStop = false;

    const child = fork(this.childModuleUrl(), [], {
      env: { ...process.env, XMTP_REPLAY_AFTER_ISO: replayAfter },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'json',
      execArgv: import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : [],
    });
    this.child = child;

    const readyPromise = new Promise<ChildReady>((resolve, reject) => {
      this.childReadyResolve = resolve;
      this.childReadyReject = reject;
    });

    child.on('message', (raw: ChildToParentMessage) => this.onChildMessage(child, raw));
    child.once('error', (error) => {
      if (this.child === child) this.childReadyReject?.(error);
    });
    child.once('exit', (code, signal) => this.onChildExit(child, code, signal));

    const timeout = delay(180_000, undefined, { ref: false }).then(() => {
      throw new Error('Timed out waiting for XMTP child readiness');
    });
    const ready = await Promise.race([readyPromise, timeout]);
    this.validateChildIdentity(ready);

    this.state.currentInboxId = ready.currentInboxId;
    this.state.pinnedInboxId = ready.pinnedInboxId;
    this.state.installationId = ready.installationId;
    this.state.streamConnected = true;
    this.state.phase = allowDeliveries ? 'ready' : 'backing_up';
    this.state.ready = allowDeliveries;
    this.acceptingDeliveries = allowDeliveries;
    this.state.lastError = null;
    this.log.info(
      { inboxId: ready.currentInboxId, installationId: ready.installationId, replayAfter },
      'xmtp.child_ready',
    );
    return ready;
  }

  private validateChildIdentity(ready: ChildReady): void {
    const expectedInboxId = this.config.xmtpExpectedInboxId ?? this.expectedManifest?.inboxId;
    const expectedInstallationId =
      this.config.xmtpExpectedInstallationId ?? this.expectedManifest?.installationId;
    if (!ready.pinnedInboxId || ready.pinnedInboxId !== ready.currentInboxId) {
      throw new RecoveryRequiredError('Client.inboxId does not match xmtp-inbox-id.txt');
    }
    if (expectedInboxId && ready.currentInboxId !== expectedInboxId) {
      throw new RecoveryRequiredError('Client.inboxId does not match independently expected inbox ID');
    }
    if (expectedInstallationId && ready.installationId !== expectedInstallationId) {
      throw new RecoveryRequiredError(
        'Client.installationId does not match snapshot/independently expected installation ID',
      );
    }
  }

  private onChildMessage(child: ChildProcess, message: ChildToParentMessage): void {
    if (this.child !== child || !message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      this.childReadyResolve?.(message);
      this.childReadyResolve = null;
      this.childReadyReject = null;
      return;
    }
    if (message.type === 'fatal') {
      const error = message.recoveryRequired
        ? new RecoveryRequiredError(message.error.replace(/^recovery_required:\s*/i, ''))
        : new Error(message.error);
      this.state.lastError = message.error;
      this.state.ready = false;
      this.state.streamConnected = false;
      this.acceptingDeliveries = false;
      this.childReadyReject?.(error);
      this.log.error({ error }, 'xmtp.child_reported_fatal');
      if (message.recoveryRequired) {
        this.markFatal(error);
      } else {
        this.state.phase = 'degraded';
        this.ensureFatalChildExits(child);
      }
      return;
    }
    if (message.type === 'delivery_result') {
      const pending = this.pendingDeliveries.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingDeliveries.delete(message.requestId);
      if (message.ok) pending.resolve(message.xmtpMessageId);
      else pending.reject(new Error(message.error));
      return;
    }
    if (message.type === 'status') this.applyChildStatus(message);
  }

  private applyChildStatus(message: Extract<ChildToParentMessage, { type: 'status' }>): void {
    switch (message.event) {
      case 'xmtp_stream_started':
        this.state.streamConnected = true;
        break;
      case 'xmtp_stream_failed':
        this.state.streamConnected = false;
        this.state.ready = false;
        this.state.phase = 'degraded';
        this.state.lastError = 'XMTP stream reported failure';
        this.acceptingDeliveries = false;
        if (
          this.child
          && !this.intentionalChildStop
          && !this.shuttingDown
          && !this.processRestartRequested
          && !this.recoveryRequired
        ) {
          const failedChild = this.child;
          this.log.error({ childPid: failedChild.pid }, 'xmtp.stream_failure_restarting_child');
          failedChild.kill('SIGTERM');
          this.ensureFatalChildExits(failedChild);
        }
        break;
      case 'xmtp_message_received':
        this.state.lastXmtpMessageReceivedAt = message.at;
        this.state.dirty = true;
        break;
      case 'edge_event_delivered':
        this.state.lastEdgeEventDeliveredAt = message.at;
        break;
      case 'edge_event_retry':
        this.state.lastError = message.detail ?? 'edge event delivery failed';
        break;
      case 'source_message_processed': {
        const sourceTime = message.detail ? Date.parse(message.detail) : Number.NaN;
        if (Number.isFinite(sourceTime) && sourceTime <= Date.now() + this.config.replayOverlapMs) {
          const previousWatermark = this.replayWatermark ? Date.parse(this.replayWatermark) : Number.NEGATIVE_INFINITY;
          if (sourceTime > previousWatermark) this.replayWatermark = new Date(sourceTime).toISOString();
          const candidateReplayAfter = sourceTime - this.config.replayOverlapMs;
          if (candidateReplayAfter > Date.parse(this.replayAfter)) {
            this.replayAfter = new Date(candidateReplayAfter).toISOString();
          }
        } else if (Number.isFinite(sourceTime)) {
          this.log.warn(
            { sourceTimestamp: message.detail },
            'xmtp.replay_watermark_future_timestamp_ignored',
          );
        }
        break;
      }
      case 'inbound_email_delivered':
        this.state.lastInboundEmailDeliveredAt = message.at;
        this.state.dirty = true;
        break;
      case 'outbound_result_delivered':
        this.state.lastOutboundResultDeliveredAt = message.at;
        this.state.dirty = true;
        break;
      default:
        this.log.debug({ childEvent: message.event }, 'xmtp.child_status');
    }
  }

  private onChildExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) return;
    if (this.fatalChildExitTimer) {
      clearTimeout(this.fatalChildExitTimer);
      this.fatalChildExitTimer = null;
    }
    this.child = null;
    this.state.streamConnected = false;
    this.state.ready = false;
    this.acceptingDeliveries = false;
    this.rejectPendingDeliveries(new Error(`XMTP child exited (code=${code}, signal=${signal})`));
    this.childReadyReject?.(new Error(`XMTP child exited before readiness (code=${code}, signal=${signal})`));
    this.childReadyResolve = null;
    this.childReadyReject = null;
    this.childExitResolve?.({ code, signal });
    this.childExitResolve = null;

    if (
      this.intentionalChildStop
      || this.shuttingDown
      || this.processRestartRequested
      || this.recoveryRequired
    ) return;
    this.state.phase = 'degraded';
    this.state.streamRestarts += 1;
    this.state.lastError = `XMTP child exited unexpectedly (code=${code}, signal=${signal})`;
    this.log.error({ code, signal }, 'xmtp.child_unexpected_exit');
    this.scheduleChildRestart();
  }

  private ensureFatalChildExits(child: ChildProcess): void {
    if (this.fatalChildExitTimer) clearTimeout(this.fatalChildExitTimer);
    this.fatalChildExitTimer = setTimeout(() => {
      this.fatalChildExitTimer = null;
      if (this.child !== child) return;
      this.log.error({ childPid: child.pid }, 'xmtp.fatal_child_exit_timeout');
      child.kill('SIGKILL');
    }, 5_000);
    this.fatalChildExitTimer.unref();
  }

  private scheduleChildRestart(): void {
    if (
      this.restartTimer
      || this.shuttingDown
      || this.processRestartRequested
      || this.recoveryRequired
    ) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.runLifecycle(async () => {
        try {
          await this.startChild(this.replayAfter);
        } catch (error) {
          if (startupFailureDisposition(error) === 'hold_for_operator') {
            this.markFatal(error);
            return;
          }
          this.log.fatal({ error }, 'xmtp.child_restart_requires_process_restart');
          this.requestProcessRestart(error);
        }
      });
    }, 5_000);
    this.restartTimer.unref();
  }

  private rejectPendingDeliveries(error: Error): void {
    for (const pending of this.pendingDeliveries.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingDeliveries.clear();
  }

  private sendChild(message: ParentToChildMessage): void {
    if (!this.child?.connected) throw new Error('xmtp_child_not_connected');
    this.child.send(message);
  }

  private requestChildDelivery(request: DeliveryRequest): Promise<string> {
    if (!this.acceptingDeliveries || !this.child?.connected || !this.state.isReady()) {
      return Promise.reject(new Error('xmtp_not_ready'));
    }
    const requestId = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDeliveries.delete(requestId);
        reject(new Error('xmtp_delivery_timeout_ambiguous'));
      }, 120_000);
      timer.unref();
      this.pendingDeliveries.set(requestId, { resolve, reject, timer });
      try {
        this.sendChild({ type: 'deliver', requestId, request });
      } catch (error) {
        clearTimeout(timer);
        this.pendingDeliveries.delete(requestId);
        reject(error);
      }
    });
  }

  async deliver(
    request: DeliveryRequest,
  ): Promise<{ jobId: string; xmtpMessageId: string; deduplicated: boolean }> {
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const existing = this.deliveryCache.get(request.jobId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('job_id_payload_conflict');
      const result = await existing.promise;
      return { ...result, deduplicated: true };
    }

    const promise = this.requestChildDelivery(request)
      .then((xmtpMessageId) => ({ jobId: request.jobId, xmtpMessageId, deduplicated: false }))
      .catch((error) => {
        this.deliveryCache.delete(request.jobId);
        throw error;
      });
    this.deliveryCache.set(request.jobId, { fingerprint, promise, createdAt: Date.now() });
    this.pruneDeliveryCache();
    return promise;
  }

  private pruneDeliveryCache(): void {
    if (this.deliveryCache.size <= 5_000) return;
    const sorted = [...this.deliveryCache.entries()].sort(
      (left, right) => left[1].createdAt - right[1].createdAt,
    );
    for (const [jobId] of sorted.slice(0, this.deliveryCache.size - 5_000)) {
      this.deliveryCache.delete(jobId);
    }
  }

  async backup(reason: string): Promise<SnapshotManifest> {
    try {
      return await this.runLifecycle(async () => this.backupExclusive(reason));
    } catch (error) {
      if (startupFailureDisposition(error) === 'hold_for_operator') this.markFatal(error);
      else this.requestProcessRestart(error);
      throw error;
    }
  }

  private async backupExclusive(reason: string): Promise<SnapshotManifest> {
    if (this.shuttingDown && reason !== 'shutdown') throw new Error('supervisor_shutting_down');
    const currentInboxId = this.state.currentInboxId;
    const installationId = this.state.installationId;
    if (!currentInboxId || !installationId) throw new Error('xmtp_identity_not_ready');

    this.state.phase = 'backing_up';
    this.state.ready = false;
    this.acceptingDeliveries = false;
    await this.waitForPendingDeliveries();
    const stoppedCleanly = await this.stopChild(`backup:${reason}`);
    if (!stoppedCleanly) {
      await this.startChild(this.replayAfter, false);
      throw new Error('XMTP child did not exit cleanly; refusing to snapshot potentially live state');
    }

    let manifest: SnapshotManifest | null = null;
    let backupError: unknown = null;
    try {
      manifest = await createQuiescedSnapshot({
        store: this.store,
        prefix: this.config.r2Prefix,
        dataDir: this.config.dataDir,
        xmtpEnv: this.config.xmtpEnv,
        expectedInboxId: this.config.xmtpExpectedInboxId,
        expectedInstallationId: this.config.xmtpExpectedInstallationId,
        currentInboxId,
        installationId,
        sourceBootId: this.state.bootId,
        reason,
        replayAfter: this.replayAfter,
        replayWatermark: this.replayWatermark,
        manifestSigningKey: this.config.snapshotSigningKey,
        partSizeBytes: this.config.backupPartBytes,
        maxBackupBytes: this.config.maxBackupBytes,
        freeSpaceMarginBytes: this.config.freeSpaceMarginBytes,
      });
      this.expectedManifest = manifest;
      // Never advance replay based on snapshot time. Only a source message
      // safely processed (durably handed off or intentionally ignored) may
      // move this cutoff forward.
      this.replayAfter = manifest.replayAfter;
      this.state.recovery = {
        manifestKey: `${this.config.r2Prefix}/latest.json`,
        databaseKey: primaryDatabaseObjectKey(manifest),
        databasePartCount: databasePartCount(manifest),
        sha256: manifest.database.sha256,
        createdAt: manifest.createdAt,
        restoredAt: this.state.recovery?.restoredAt ?? null,
      };
      this.state.lastBackupAt = manifest.createdAt;
      this.state.lastBackupError = null;
      this.state.dirty = false;
      this.log.info(
        { snapshotId: manifest.snapshotId, databaseBytes: manifest.database.bytes, reason },
        'xmtp.snapshot_published',
      );
    } catch (error) {
      backupError = error;
      this.state.lastBackupError = errorMessage(error);
      this.state.lastError = errorMessage(error);
      this.log.error({ error, reason }, 'xmtp.snapshot_failed');
    }

    if (backupError instanceof RecoveryRequiredError) {
      // Identity, consistency, integrity, or freshness failures require an
      // operator. Do not restart the XMTP child on state that failed the
      // recovery contract.
      this.markFatal(backupError);
      throw backupError;
    }

    try {
      await this.startChild(this.replayAfter, backupError === null);
    } catch (restartError) {
      this.state.phase = 'fatal';
      this.state.lastError = errorMessage(restartError);
      throw restartError;
    }

    if (backupError || !manifest) {
      this.state.phase = 'degraded';
      this.state.ready = false;
      this.acceptingDeliveries = false;
      throw backupError instanceof Error ? backupError : new Error(errorMessage(backupError));
    }

    this.state.phase = 'ready';
    this.state.ready = true;
    this.acceptingDeliveries = true;
    return manifest;
  }

  private async waitForPendingDeliveries(): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (this.pendingDeliveries.size > 0) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${this.pendingDeliveries.size} XMTP deliveries to quiesce`);
      }
      await delay(100, undefined, { ref: false });
    }
  }

  private async stopChild(reason: string): Promise<boolean> {
    const child = this.child;
    // A backup must prove that *it* quiesced a live child. If the child already
    // disappeared, its exit was not part of this handshake and is not a safe
    // basis for copying the DB even when SQLite sidecars happen to be absent.
    if (!child) return false;
    this.intentionalChildStop = true;
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      this.childExitResolve = resolve;
    });
    try {
      this.sendChild({ type: 'shutdown', reason });
    } catch {
      child.kill('SIGTERM');
    }

    const timeoutMarker = Symbol('timeout');
    const result = await Promise.race([
      exitPromise,
      delay(120_000, timeoutMarker, { ref: false }),
    ]);
    if (result === timeoutMarker) {
      this.log.error({ reason }, 'xmtp.child_stop_timeout');
      child.kill('SIGKILL');
      await exitPromise;
      return false;
    }
    return result.code === 0 && result.signal === null;
  }

  private schedulePeriodicBackup(): void {
    this.backupTimer = setInterval(() => {
      void this.backup('periodic').catch((error) => {
        this.log.error({ error }, 'xmtp.periodic_backup_failed');
      });
    }, this.config.backupIntervalMs);
    this.backupTimer.unref();
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = run.catch(() => undefined);
    return run;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.state.phase = 'shutting_down';
    this.state.ready = false;
    this.acceptingDeliveries = false;
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.fatalChildExitTimer) {
      clearTimeout(this.fatalChildExitTimer);
      this.fatalChildExitTimer = null;
    }
    await this.runLifecycle(async () => {
      await this.waitForPendingDeliveries();
      const stoppedCleanly = await this.stopChild('supervisor_shutdown');
      if (!stoppedCleanly || !this.state.currentInboxId || !this.state.installationId) return;
      try {
        const manifest = await createQuiescedSnapshot({
          store: this.store,
          prefix: this.config.r2Prefix,
          dataDir: this.config.dataDir,
          xmtpEnv: this.config.xmtpEnv,
          expectedInboxId: this.config.xmtpExpectedInboxId,
          expectedInstallationId: this.config.xmtpExpectedInstallationId,
          currentInboxId: this.state.currentInboxId,
          installationId: this.state.installationId,
          sourceBootId: this.state.bootId,
          reason: 'shutdown',
          replayAfter: this.replayAfter,
          replayWatermark: this.replayWatermark,
          manifestSigningKey: this.config.snapshotSigningKey,
          partSizeBytes: this.config.backupPartBytes,
          maxBackupBytes: this.config.maxBackupBytes,
          freeSpaceMarginBytes: this.config.freeSpaceMarginBytes,
        });
        this.state.lastBackupAt = manifest.createdAt;
      } catch (error) {
        this.log.error({ error }, 'xmtp.shutdown_snapshot_failed');
      }
    });
  }

  markFatal(error: unknown): void {
    if (this.recoveryRequired) return;
    this.recoveryRequired = true;
    const message = errorMessage(error);
    this.state.phase = 'fatal';
    this.state.ready = false;
    this.state.streamConnected = false;
    this.state.lastError = message;
    this.acceptingDeliveries = false;
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.fatalChildExitTimer) {
      clearTimeout(this.fatalChildExitTimer);
      this.fatalChildExitTimer = null;
    }
    this.log.fatal(
      { error, alert: 'XMTP_RECOVERY_REQUIRED', allowNewInstallation: this.config.allowNewInstallation },
      'xmtp.recovery_required',
    );
    void this.runLifecycle(async () => {
      try {
        await this.stopChild('fatal_recovery_required');
      } catch (stopError) {
        this.log.error({ error: stopError }, 'xmtp.fatal_child_stop_failed');
      }
    });
  }

  private requestProcessRestart(error: unknown): void {
    if (this.processRestartRequested || this.shuttingDown || this.recoveryRequired) return;
    this.processRestartRequested = true;
    this.state.phase = 'fatal';
    this.state.ready = false;
    this.state.streamConnected = false;
    this.state.lastError = errorMessage(error);
    this.acceptingDeliveries = false;
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.fatalChildExitTimer) {
      clearTimeout(this.fatalChildExitTimer);
      this.fatalChildExitTimer = null;
    }
    this.log.fatal(
      { error, alert: 'XMTP_PROCESS_RESTART_REQUIRED' },
      'xmtp.process_restart_required',
    );
    this.lifecycleHooks.onProcessRestartRequired(error);
  }

  internalStatus(): Record<string, unknown> {
    return {
      ...this.state.internalStatus(),
      childPid: this.child?.pid ?? null,
      pendingDeliveries: this.pendingDeliveries.size,
      deliveryCacheEntries: this.deliveryCache.size,
      acceptingDeliveries: this.acceptingDeliveries,
      snapshotPrefix: this.config.r2Prefix,
      replayAfter: this.replayAfter,
      replayWatermark: this.replayWatermark,
      processRestartRequested: this.processRestartRequested,
      recoveryRequired: this.recoveryRequired,
    };
  }
}
