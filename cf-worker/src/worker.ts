import { getContainer } from '@cloudflare/containers';
import { requireAdminAuth, requireRecoveryAuth } from './auth';
import type { RelayEnv } from './bindings';
import { ContainerProxy, XmtpRelayContainer, handleR2ObjectRequest } from './container';
import {
  createInboundDeliveryJob,
  createResultDeliveryJob,
  getDeliveryJob,
  getInboundEmail,
  getOutboundRequest,
  getRelayState,
  getStatusSnapshot,
  listAbandonedInflight,
  listOrphanedBrokerWork,
  listRecoverableWork,
  markDeliveryQueued,
  markDeliveryUncertain,
  markOutboundFailed,
  markOutboundQueued,
  refreshDeliveryBrokerHandoff,
  refreshOutboundBrokerHandoff,
  recordQueueFailure,
  seedConfiguredAllowlist,
  setRelayState,
} from './db';
import { handleXmtpEventRequest } from './events';
import { handleInboundEmail } from './inbound';
import type { QueueMessage } from './protocol';
import { emailSendResultForRow, handleQueueBatch } from './queues';
import {
  PRODUCTION_CONTAINER_NAME,
  configuredContainerName,
  envInteger,
  errorMessage,
  isWatchdogActivationState,
  readJsonWithLimit,
  structuredLog,
  type WatchdogActivationState,
} from './runtime';

type WatchdogState = WatchdogActivationState & { at: string };
type RecoveryAction = 'start' | 'stop' | 'restart' | 'recreate';

// Wrangler must see the Durable Object class and Containers outbound proxy as
// runtime exports from the configured main module.
export { ContainerProxy, XmtpRelayContainer };

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/healthz') {
      try {
        await env.RELAY_DB.prepare('SELECT 1').first();
        return json({ ok: true, service: 'xmtp-mx-relay-edge' }, 200);
      } catch (error) {
        structuredLog('error', 'edge.health.failed', { error: errorMessage(error) });
        return json({ ok: false, service: 'xmtp-mx-relay-edge' }, 503);
      }
    }

    if (url.pathname === '/internal/v1/xmtp/events') {
      return handleXmtpEventRequest(request, env);
    }

    if (url.pathname.startsWith('/internal/v1/admin/recovery/objects/')) {
      return handleRecoveryObjectRequest(request, env, url);
    }

    if (request.method === 'GET' && url.pathname === '/internal/v1/status') {
      const unauthorized = requireAdminAuth(request, env);
      if (unauthorized) return unauthorized;
      return handleStatus(env);
    }

    if (request.method === 'POST' && url.pathname === '/internal/v1/container/backup') {
      const unauthorized = requireAdminAuth(request, env);
      if (unauthorized) return unauthorized;
      return handleContainerBackup(request, env);
    }

    const controlMatch = url.pathname.match(/^\/internal\/v1\/container\/(start|stop|restart|recreate)$/);
    if (request.method === 'POST' && controlMatch?.[1]) {
      const unauthorized = requireAdminAuth(request, env);
      if (unauthorized) return unauthorized;
      return handleContainerControl(controlMatch[1] as RecoveryAction, request, env);
    }

    return json({ ok: false, error: 'not_found' }, 404);
  },

  async email(message: ForwardableEmailMessage, env: RelayEnv): Promise<void> {
    await handleInboundEmail(message, env);
  },

  async queue(batch: MessageBatch<QueueMessage>, env: RelayEnv): Promise<void> {
    await handleQueueBatch(batch, env);
  },

  async scheduled(_event: ScheduledController, env: RelayEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runWatchdog(env));
  },
} satisfies ExportedHandler<RelayEnv, QueueMessage>;

export async function runWatchdog(env: RelayEnv): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    await seedConfiguredAllowlist(env);

    const rawPause = await getRelayState<unknown>(env, 'watchdog_pause');
    if (!isWatchdogActivationState(rawPause)) {
      await setRelayState(env, 'container_watchdog', {
        ok: false,
        configured: false,
        paused: null,
        activationRequired: true,
        checkedAt: startedAt,
      });
      structuredLog('error', 'container.watchdog.activation_required', {
        reason: rawPause === null ? 'missing_pause_state' : 'invalid_pause_state',
      });
      return;
    }
    const pause = rawPause;
    if (pause.paused) {
      await setRelayState(env, 'container_watchdog', {
        ok: true,
        paused: true,
        checkedAt: startedAt,
      });
      structuredLog('info', 'container.watchdog.paused', { pausedAt: pause.at, reason: pause.reason });
      return;
    }

    const container = relayContainer(env);
    let state = await container.getState();
    if (state.status !== 'healthy') {
      await container.startAndWaitForPorts({
        ports: [8080],
        cancellationOptions: { portReadyTimeoutMS: 120_000 },
      });
      state = await container.getState();
    }

    const readiness = await container.fetch(new Request('http://container/readyz', {
      signal: AbortSignal.timeout(30_000),
    }));
    const readinessBody = await safeJson(readiness);
    await setRelayState(env, 'container_watchdog', {
      ok: readiness.ok,
      state,
      readiness: readinessBody,
      checkedAt: startedAt,
    });
    structuredLog(readiness.ok ? 'info' : 'warn', 'container.watchdog.checked', {
      status: state.status,
      ready: readiness.ok,
    });

    // Outbox repair is independent of singleton liveness. Queue or D1 handoff
    // failures must never suppress restart/checking of an exited XMTP listener.
    try {
      await recoverStrandedJobs(env);
    } catch (error) {
      structuredLog('error', 'queue.watchdog.failed', { error: errorMessage(error) });
    }
    try {
      await quarantineAbandonedInflight(env);
    } catch (error) {
      structuredLog('error', 'queue.watchdog.abandoned_scan_failed', { error: errorMessage(error) });
    }
    try {
      await recoverOrphanedBrokerHandoffs(env);
    } catch (error) {
      structuredLog('error', 'queue.watchdog.orphan_scan_failed', { error: errorMessage(error) });
    }
  } catch (error) {
    const detail = errorMessage(error);
    await setRelayState(env, 'container_watchdog', {
      ok: false,
      error: detail,
      checkedAt: startedAt,
    }).catch(() => undefined);
    structuredLog('error', 'container.watchdog.failed', { error: detail });
    throw error;
  }
}

async function recoverStrandedJobs(env: RelayEnv): Promise<void> {
  const replayAgeSeconds = envInteger(env.QUEUE_REPLAY_STALE_SECONDS, 300, {
    min: 60,
    max: 3_600,
  });
  const staleBefore = new Date(Date.now() - replayAgeSeconds * 1_000).toISOString();
  const work = await listRecoverableWork(env, staleBefore);
  let failed = 0;

  const repair = async (kind: string, id: string | number, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      failed += 1;
      structuredLog('error', 'queue.watchdog.requeue_failed', {
        kind,
        id,
        error: errorMessage(error),
      });
    }
  };

  for (const inboundId of work.inboundIds) {
    await repair('inbound', inboundId, async () => {
      const row = await getInboundEmail(env, inboundId);
      if (!row) return;
      const job = await createInboundDeliveryJob(env, row);
      if (job.status !== 'received') return;
      await env.XMTP_DELIVERY_QUEUE.send({ version: 1, kind: 'xmtp_delivery', jobId: job.job_id });
      await markDeliveryQueued(env, job.job_id);
    });
  }

  for (const xmtpMessageId of work.outboundIds) {
    await repair('outbound', xmtpMessageId, async () => {
      await env.EMAIL_DELIVERY_QUEUE.send({ version: 1, kind: 'email_delivery', xmtpMessageId });
      await markOutboundQueued(env, xmtpMessageId);
    });
  }

  for (const xmtpMessageId of work.outboundResultIds) {
    await repair('outbound_result', xmtpMessageId, async () => {
      const row = await getOutboundRequest(env, xmtpMessageId);
      if (!row || row.result_delivered_at !== null) return;

      const result = emailSendResultForRow(row);
      if (!result) return;

      const job = await createResultDeliveryJob(env, row, result);
      if (job.status !== 'received') return;
      await env.XMTP_DELIVERY_QUEUE.send({ version: 1, kind: 'xmtp_delivery', jobId: job.job_id });
      await markDeliveryQueued(env, job.job_id);
    });
  }

  for (const jobId of work.deliveryJobIds) {
    await repair('xmtp_delivery', jobId, async () => {
      await env.XMTP_DELIVERY_QUEUE.send({ version: 1, kind: 'xmtp_delivery', jobId });
      await markDeliveryQueued(env, jobId);
    });
  }

  if (
    work.inboundIds.length
    || work.outboundIds.length
    || work.outboundResultIds.length
    || work.deliveryJobIds.length
  ) {
    structuredLog('info', 'queue.watchdog.requeued', {
      inbound: work.inboundIds.length,
      outbound: work.outboundIds.length,
      outboundResult: work.outboundResultIds.length,
      xmtpDelivery: work.deliveryJobIds.length,
      failed,
    });
  }
}

async function quarantineAbandonedInflight(env: RelayEnv): Promise<void> {
  const abandonedSeconds = envInteger(env.QUEUE_ABANDONED_SECONDS, 21_600, {
    min: 7_200,
    max: 7 * 24 * 60 * 60,
  });
  const staleBefore = new Date(Date.now() - abandonedSeconds * 1_000).toISOString();
  const work = await listAbandonedInflight(env, staleBefore);

  for (const xmtpMessageId of work.outboundIds) {
    try {
      const row = await getOutboundRequest(env, xmtpMessageId);
      if (!row || row.status !== 'sending') continue;
      const terminal = await markOutboundFailed(
        env,
        xmtpMessageId,
        'uncertain',
        'delivery_state_unknown_after_abandoned_inflight',
        'sending',
      );
      if (terminal.status === 'uncertain') {
        await recordQueueFailure(
          env,
          'watchdog-abandoned-email-delivery',
          xmtpMessageId,
          terminal.attempt_count,
          'delivery_state_unknown_after_abandoned_inflight',
        );
      }
      const result = emailSendResultForRow(terminal);
      if (!result || terminal.result_delivered_at !== null) continue;
      const job = await createResultDeliveryJob(env, terminal, result);
      if (job.status !== 'received') continue;
      await env.XMTP_DELIVERY_QUEUE.send({ version: 1, kind: 'xmtp_delivery', jobId: job.job_id });
      await markDeliveryQueued(env, job.job_id);
    } catch (error) {
      structuredLog('error', 'queue.watchdog.abandoned_quarantine_failed', {
        kind: 'outbound',
        id: xmtpMessageId,
        error: errorMessage(error),
      });
    }
  }

  for (const jobId of work.deliveryJobIds) {
    try {
      const job = await getDeliveryJob(env, jobId);
      if (!job || job.status !== 'delivering') continue;
      await markDeliveryUncertain(env, jobId, 'delivery_state_unknown_after_abandoned_inflight');
      const terminal = await getDeliveryJob(env, jobId);
      if (terminal?.status === 'uncertain') {
        await recordQueueFailure(
          env,
          'watchdog-abandoned-xmtp-delivery',
          jobId,
          terminal.attempt_count,
          'delivery_state_unknown_after_abandoned_inflight',
        );
      }
    } catch (error) {
      structuredLog('error', 'queue.watchdog.abandoned_quarantine_failed', {
        kind: 'xmtp_delivery',
        id: jobId,
        error: errorMessage(error),
      });
    }
  }

  if (work.outboundIds.length || work.deliveryJobIds.length) {
    structuredLog('error', 'queue.watchdog.abandoned_quarantined', {
      outbound: work.outboundIds.length,
      xmtpDelivery: work.deliveryJobIds.length,
      staleBefore,
    });
  }
}

async function recoverOrphanedBrokerHandoffs(env: RelayEnv): Promise<void> {
  const orphanedSeconds = envInteger(env.QUEUE_ORPHANED_HANDOFF_SECONDS, 86_400, {
    // This horizon is deliberately much longer than the complete primary plus
    // DLQ retry schedule. It is not the short D1-to-Queue handoff sweeper.
    min: 86_400,
    max: 14 * 24 * 60 * 60,
  });
  const staleBefore = new Date(Date.now() - orphanedSeconds * 1_000).toISOString();
  const work = await listOrphanedBrokerWork(env, staleBefore);
  let failed = 0;

  for (const row of work.outbound) {
    try {
      await env.EMAIL_DELIVERY_QUEUE.send({
        version: 1,
        kind: 'email_delivery',
        xmtpMessageId: row.xmtpMessageId,
      });
      // Refresh only after a confirmed Queue send and only while the original
      // safe predecessor remains current. A consumer claim wins this CAS.
      await refreshOutboundBrokerHandoff(env, row.xmtpMessageId, row.status);
    } catch (error) {
      failed += 1;
      structuredLog('error', 'queue.watchdog.orphan_republish_failed', {
        kind: 'outbound',
        id: row.xmtpMessageId,
        status: row.status,
        error: errorMessage(error),
      });
    }
  }

  for (const job of work.delivery) {
    try {
      await env.XMTP_DELIVERY_QUEUE.send({
        version: 1,
        kind: 'xmtp_delivery',
        jobId: job.jobId,
      });
      await refreshDeliveryBrokerHandoff(env, job.jobId, job.status);
    } catch (error) {
      failed += 1;
      structuredLog('error', 'queue.watchdog.orphan_republish_failed', {
        kind: 'xmtp_delivery',
        id: job.jobId,
        status: job.status,
        error: errorMessage(error),
      });
    }
  }

  if (work.outbound.length || work.delivery.length) {
    structuredLog('warn', 'queue.watchdog.orphan_republished', {
      outbound: work.outbound.length,
      xmtpDelivery: work.delivery.length,
      failed,
      staleBefore,
    });
  }
}

async function handleStatus(env: RelayEnv): Promise<Response> {
  try {
    const snapshot = await getStatusSnapshot(env);
    const rawPause = await getRelayState<unknown>(env, 'watchdog_pause');
    const pause = isWatchdogActivationState(rawPause) ? rawPause : null;
    const container = relayContainer(env);
    const state = await container.getState();
    let relayStatus: unknown = null;
    let relayStatusError: string | null = null;

    if (pause?.paused === false && (state.status === 'healthy' || state.status === 'running')) {
      try {
        const response = await container.fetch(new Request('http://container/internal/v1/status', {
          headers: { authorization: `Bearer ${env.CONTAINER_SHARED_SECRET}` },
          signal: AbortSignal.timeout(15_000),
        }));
        relayStatus = await safeJson(response);
        if (!response.ok) relayStatusError = `container_status_${response.status}`;
      } catch (error) {
        relayStatusError = errorMessage(error);
      }
    }

    return json({
      ok: true,
      generatedAt: new Date().toISOString(),
      container: {
        instanceName: configuredContainerName(env),
        state,
        watchdogConfigured: pause !== null,
        watchdogPaused: pause?.paused ?? null,
        relay: relayStatus,
        error: relayStatusError,
      },
      ...snapshot,
    }, 200);
  } catch (error) {
    structuredLog('error', 'edge.status.failed', { error: errorMessage(error) });
    return json({ ok: false, error: 'status_unavailable' }, 503);
  }
}

async function handleContainerControl(
  action: RecoveryAction,
  request: Request,
  env: RelayEnv,
): Promise<Response> {
  const name = configuredContainerName(env);
  if (name !== PRODUCTION_CONTAINER_NAME) {
    return json({ ok: false, error: 'invalid_container_configuration' }, 409);
  }

  let input: unknown;
  try {
    input = await readJsonWithLimit(request, 4_096);
  } catch {
    return json({ ok: false, error: 'invalid_request' }, 400);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return json({ ok: false, error: 'invalid_request' }, 400);
  }
  const body = input as Record<string, unknown>;
  if (body.confirm !== PRODUCTION_CONTAINER_NAME) {
    return json({ ok: false, error: 'confirmation_required' }, 409);
  }

  if ((action === 'restart' || action === 'recreate') && env.RECOVERY_DRILL_ENABLED !== 'true') {
    return json({ ok: false, error: 'recovery_drill_disabled' }, 403);
  }
  if (
    (action === 'restart' || action === 'recreate')
    && body.expectedInboxId !== env.XMTP_EXPECTED_INBOX_ID
  ) {
    return json({ ok: false, error: 'expected_inbox_confirmation_required' }, 409);
  }
  if (action === 'stop' && body.pauseWatchdog !== true) {
    return json({ ok: false, error: 'pause_watchdog_confirmation_required' }, 409);
  }

  const container = relayContainer(env);
  try {
    if (action === 'stop') {
      await setRelayState(env, 'watchdog_pause', {
        paused: true,
        at: new Date().toISOString(),
        reason: 'operator_stop',
      } satisfies WatchdogState);
      await container.stop('SIGTERM');
      const state = await container.getState();
      structuredLog('warn', 'container.control.stop', { state: state.status });
      return json({ ok: true, action, state, watchdogPaused: true }, 200);
    }

    if (action === 'start') {
      await setRelayState(env, 'watchdog_pause', {
        paused: false,
        at: new Date().toISOString(),
        reason: 'operator_start',
      } satisfies WatchdogState);
      await startContainer(container);
      const state = await container.getState();
      structuredLog('info', 'container.control.start', { state: state.status });
      return json({ ok: true, action, state, watchdogPaused: false }, 200);
    }

    if (action === 'restart') {
      await container.stop('SIGTERM');
      await startContainer(container);
    } else {
      await container.destroy();
      await startContainer(container);
    }
    const state = await container.getState();
    const readiness = await container.fetch(new Request('http://container/readyz', {
      signal: AbortSignal.timeout(30_000),
    }));
    const readinessBody = await safeJson(readiness);
    structuredLog('warn', `container.control.${action}`, {
      state: state.status,
      ready: readiness.ok,
    });
    return json({ ok: readiness.ok, action, state, readiness: readinessBody }, readiness.ok ? 200 : 503);
  } catch (error) {
    structuredLog('error', `container.control.${action}_failed`, { error: errorMessage(error) });
    return json({ ok: false, action, error: errorMessage(error) }, 503);
  }
}

async function handleContainerBackup(request: Request, env: RelayEnv): Promise<Response> {
  let input: unknown;
  try {
    input = await readJsonWithLimit(request, 16 * 1024);
  } catch {
    return json({ ok: false, error: 'invalid_request' }, 400);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return json({ ok: false, error: 'invalid_request' }, 400);
  }
  const body = input as Record<string, unknown>;
  if (body.confirm !== PRODUCTION_CONTAINER_NAME) {
    return json({ ok: false, error: 'confirmation_required' }, 409);
  }
  if (
    typeof body.reason !== 'string'
    || body.reason.trim().length === 0
    || body.reason.trim().length > 200
  ) {
    return json({ ok: false, error: 'backup_reason_required' }, 400);
  }
  const reason = body.reason.trim();

  try {
    const container = relayContainer(env);
    const state = await container.getState();
    if (state.status !== 'healthy' && state.status !== 'running') {
      return json({ ok: false, error: 'container_not_running', state }, 409);
    }
    const response = await container.fetch(new Request(
      'http://container/internal/v1/admin/backup',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.CONTAINER_SHARED_SECRET}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason }),
        signal: AbortSignal.timeout(300_000),
      },
    ));
    const responseBody = await safeJson(response);
    structuredLog(response.ok ? 'info' : 'error', 'container.backup.completed', {
      status: response.status,
      reason,
    });
    return json(responseBody ?? { ok: false, error: 'invalid_container_response' }, response.status);
  } catch (error) {
    structuredLog('error', 'container.backup.failed', { reason, error: errorMessage(error) });
    return json({ ok: false, error: 'container_backup_unavailable' }, 503);
  }
}

async function handleRecoveryObjectRequest(
  request: Request,
  env: RelayEnv,
  url: URL,
): Promise<Response> {
  const unauthorized = requireRecoveryAuth(request, env);
  if (unauthorized) return unauthorized;
  if (request.method !== 'GET' && request.method !== 'PUT') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }
  if (env.RECOVERY_IMPORT_ENABLED !== 'true') {
    return json({ ok: false, error: 'recovery_import_disabled' }, 403);
  }

  const rawPause = await getRelayState<unknown>(env, 'watchdog_pause');
  if (!isWatchdogActivationState(rawPause) || !rawPause.paused) {
    return json({ ok: false, error: 'recovery_import_requires_watchdog_pause' }, 409);
  }
  if (
    request.method === 'PUT'
    && request.headers.get('x-recovery-confirm') !== PRODUCTION_CONTAINER_NAME
  ) {
    return json({ ok: false, error: 'recovery_confirmation_required' }, 409);
  }

  let objectKey: string;
  try {
    objectKey = decodeURIComponent(
      url.pathname.slice('/internal/v1/admin/recovery/objects/'.length),
    );
  } catch {
    return json({ ok: false, error: 'invalid_key' }, 400);
  }
  if (!objectKey) return json({ ok: false, error: 'invalid_key' }, 400);

  try {
    const container = relayContainer(env);
    const state = await container.getState();
    if (state.status !== 'stopped') {
      return json({ ok: false, error: 'recovery_import_requires_stopped_container' }, 409);
    }
    const response = await handleR2ObjectRequest(request, env, { objectKey });
    structuredLog(response.ok ? 'info' : 'warn', 'recovery.object_request', {
      method: request.method,
      objectKey,
      status: response.status,
    });
    return response;
  } catch (error) {
    structuredLog('error', 'recovery.object_request_failed', {
      method: request.method,
      objectKey,
      error: errorMessage(error),
    });
    return json({ ok: false, error: 'recovery_import_unavailable' }, 503);
  }
}

async function startContainer(container: ReturnType<typeof relayContainer>): Promise<void> {
  await container.startAndWaitForPorts({
    ports: [8080],
    cancellationOptions: { portReadyTimeoutMS: 120_000 },
  });
}

function relayContainer(env: RelayEnv) {
  return getContainer<XmtpRelayContainer>(
    env.XMTP_RELAY as unknown as DurableObjectNamespace<XmtpRelayContainer>,
    configuredContainerName(env),
  );
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function json(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}
