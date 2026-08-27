import crypto from 'node:crypto';

export type RelayPhase =
  | 'starting'
  | 'restoring'
  | 'creating_xmtp_client'
  | 'syncing'
  | 'backing_up'
  | 'catching_up'
  | 'ready'
  | 'degraded'
  | 'shutting_down'
  | 'fatal';

export type SnapshotState = {
  manifestKey: string;
  databaseKey: string;
  databasePartCount: number;
  sha256: string;
  createdAt: string;
  restoredAt: string | null;
};

export class RuntimeState {
  readonly bootId = crypto.randomUUID();
  readonly startedAt = new Date().toISOString();
  phase: RelayPhase = 'starting';
  ready = false;
  streamConnected = false;
  streamRestarts = 0;
  currentInboxId: string | null = null;
  pinnedInboxId: string | null = null;
  installationId: string | null = null;
  recovery: SnapshotState | null = null;
  lastBackupAt: string | null = null;
  lastBackupError: string | null = null;
  lastXmtpMessageReceivedAt: string | null = null;
  lastInboundEmailDeliveredAt: string | null = null;
  lastOutboundResultDeliveredAt: string | null = null;
  lastEdgeEventDeliveredAt: string | null = null;
  lastError: string | null = null;
  dirty = false;

  constructor(
    readonly configuredExpectedInboxId: string | null,
    readonly configuredExpectedInstallationId: string | null,
    readonly bootGeneration: string | null,
    private readonly backupMaxStalenessMs: number,
  ) {
    this.pinnedInboxId = configuredExpectedInboxId;
  }

  isReady(now = Date.now()): boolean {
    if (!this.ready || !this.streamConnected || !this.lastBackupAt) return false;
    const backupAge = now - Date.parse(this.lastBackupAt);
    return Number.isFinite(backupAge) && backupAge <= this.backupMaxStalenessMs;
  }

  publicStatus(now = Date.now()): Record<string, unknown> {
    return {
      ok: this.phase !== 'fatal',
      ready: this.isReady(now),
      phase: this.phase,
      bootId: this.bootId,
      startedAt: this.startedAt,
    };
  }

  internalStatus(now = Date.now()): Record<string, unknown> {
    const backupAgeMs = this.lastBackupAt ? now - Date.parse(this.lastBackupAt) : null;
    return {
      ...this.publicStatus(now),
      bootGeneration: this.bootGeneration,
      deploymentId: process.env.CLOUDFLARE_DEPLOYMENT_ID ?? null,
      configuredExpectedInboxId: this.configuredExpectedInboxId,
      configuredExpectedInstallationId: this.configuredExpectedInstallationId,
      pinnedInboxId: this.pinnedInboxId,
      currentInboxId: this.currentInboxId,
      installationId: this.installationId,
      streamConnected: this.streamConnected,
      streamRestarts: this.streamRestarts,
      recovery: this.recovery,
      lastBackupAt: this.lastBackupAt,
      backupAgeMs,
      lastBackupError: this.lastBackupError,
      lastXmtpMessageReceivedAt: this.lastXmtpMessageReceivedAt,
      lastInboundEmailDeliveredAt: this.lastInboundEmailDeliveredAt,
      lastOutboundResultDeliveredAt: this.lastOutboundResultDeliveredAt,
      lastEdgeEventDeliveredAt: this.lastEdgeEventDeliveredAt,
      dirty: this.dirty,
      lastError: this.lastError,
    };
  }
}
