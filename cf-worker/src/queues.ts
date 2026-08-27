import { getContainer } from '@cloudflare/containers';
import type { RelayEnv } from './bindings';
import type { XmtpRelayContainer } from './container';
import {
  claimDeliveryJob,
  claimOutboundRequest,
  createResultDeliveryJob,
  getDeliveryJob,
  getOutboundRequest,
  getRelayState,
  markDeliveryComplete,
  markDeliveryFailed,
  markDeliveryQueued,
  markDeliveryRetry,
  markDeliveryUncertain,
  markOutboundFailed,
  markOutboundRetry,
  markOutboundSent,
  recordQueueFailure,
  setRelayState,
  type DeliveryJobRow,
  type OutboundRow,
} from './db';
import {
  isEmailAddress,
  makeEmailSendResult,
  type ContainerDeliveryRequest,
  type EmailDeliveryQueueMessage,
  type EmailInboundV1,
  type EmailSendResultV1,
  type QueueMessage,
  type XmtpDeliveryQueueMessage,
} from './protocol';
import {
  configuredContainerName,
  envInteger,
  errorCode,
  errorMessage,
  isWatchdogActivationState,
  structuredLog,
} from './runtime';

type QueueAction = { action: 'ack' } | { action: 'retry'; error: string };

const DEAD_LETTER_QUEUES = new Set([
  'xmtp-mx-email-delivery-dlq-production',
  'xmtp-mx-xmtp-delivery-dlq-production',
]);

const TRANSIENT_EMAIL_ERROR_CODES = new Set([
  'E_RATE_LIMIT_EXCEEDED',
  'E_INTERNAL_SERVER_ERROR',
]);
const PERMANENT_EMAIL_ERROR_CODES = new Set([
  'E_VALIDATION_ERROR',
  'E_FIELD_MISSING',
  'E_TOO_MANY_RECIPIENTS',
  'E_TOO_MANY_ATTACHMENTS',
  'E_SENDER_NOT_VERIFIED',
  'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_CONTENT_TOO_LARGE',
  'E_DAILY_LIMIT_EXCEEDED',
  'E_HEADER_NOT_ALLOWED',
  'E_HEADER_USE_API_FIELD',
  'E_HEADER_VALUE_INVALID',
  'E_HEADER_VALUE_TOO_LONG',
  'E_HEADER_NAME_INVALID',
  'E_HEADERS_TOO_LARGE',
  'E_HEADERS_TOO_MANY',
]);

export async function handleQueueBatch(
  batch: MessageBatch<QueueMessage>,
  env: RelayEnv,
): Promise<void> {
  if (DEAD_LETTER_QUEUES.has(batch.queue)) {
    await consumeDeadLetterBatch(batch, env);
    return;
  }

  for (const message of batch.messages) {
    let action: QueueAction;
    try {
      if (isEmailDeliveryMessage(message.body)) {
        action = await processEmailDeliveryJob(message.body, message.attempts, batch.queue, env);
      } else if (isXmtpDeliveryMessage(message.body)) {
        action = await processXmtpDeliveryJob(message.body, message.attempts, batch.queue, env);
      } else {
        structuredLog('error', 'queue.invalid_message', { queue: batch.queue, messageId: message.id });
        action = { action: 'ack' };
      }
    } catch (error) {
      const detail = errorMessage(error);
      structuredLog('error', 'queue.handler_failed', {
        queue: batch.queue,
        messageId: message.id,
        attempts: message.attempts,
        error: detail,
      });
      action = { action: 'retry', error: detail };
    }

    if (action.action === 'ack') {
      message.ack();
    } else {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}

async function consumeDeadLetterBatch(
  batch: MessageBatch<QueueMessage>,
  env: RelayEnv,
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    const jobId = isEmailDeliveryMessage(body)
      ? body.xmtpMessageId
      : isXmtpDeliveryMessage(body)
        ? body.jobId
        : message.id;
    try {
      await reconcileDeadLetter(body, env);
      await recordQueueFailure(
        env,
        batch.queue,
        jobId,
        message.attempts,
        'dead_lettered_after_delivery_retries',
      );
      structuredLog('error', 'queue.dead_letter_consumed', {
        queue: batch.queue,
        messageId: message.id,
        jobId,
        attempts: message.attempts,
      });
      message.ack();
    } catch (error) {
      const detail = errorMessage(error);
      structuredLog('error', 'queue.dead_letter_record_failed', {
        queue: batch.queue,
        messageId: message.id,
        jobId,
        error: detail,
      });
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}

async function reconcileDeadLetter(body: QueueMessage, env: RelayEnv): Promise<void> {
  const error = 'dead_lettered_after_delivery_retries';
  if (isEmailDeliveryMessage(body)) {
    const row = await getOutboundRequest(env, body.xmtpMessageId);
    if (!row) return;
    // A separate primary copy may still own `sending`; an immediate DLQ write
    // would race a definitive provider result. The long-aged watchdog handles
    // abandoned in-flight rows after the full retry horizon.
    if (row.status === 'received' || row.status === 'queued' || row.status === 'retrying') {
      const terminal = await markOutboundFailed(env, row.xmtp_msg_id, 'failed', error, row.status);
      const result = emailSendResultForRow(terminal);
      if (result) await enqueueResult(env, terminal, result);
    }
    return;
  }

  if (isXmtpDeliveryMessage(body)) {
    const job = await getDeliveryJob(env, body.jobId);
    if (!job) return;
    if (job.status === 'received' || job.status === 'queued' || job.status === 'retrying') {
      await markDeliveryFailed(env, job.job_id, error, job.status);
    }
  }
}

export async function processEmailDeliveryJob(
  message: EmailDeliveryQueueMessage,
  attempts: number,
  queueName: string,
  env: RelayEnv,
): Promise<QueueAction> {
  const row = await getOutboundRequest(env, message.xmtpMessageId);
  if (!row) {
    structuredLog('error', 'email.outbound.missing_record', { xmtpMessageId: message.xmtpMessageId });
    return { action: 'ack' };
  }

  if (row.status === 'sent') {
    await setRelayState(env, 'last_outbound_email_delivered', {
      xmtpMessageId: row.xmtp_msg_id,
      providerMessageId: row.provider_message_id,
      deliveredAt: row.updated_at,
    });
    const result = emailSendResultForRow(row);
    if (result) await enqueueResult(env, row, result);
    return { action: 'ack' };
  }
  if (row.status === 'failed' || row.status === 'uncertain') {
    const result = emailSendResultForRow(row);
    if (result) await enqueueResult(env, row, result);
    return { action: 'ack' };
  }
  if (row.status === 'denied' || row.status === 'invalid') return { action: 'ack' };
  if (row.status === 'sending') {
    // A concurrent Queue copy can observe the first copy's in-flight claim.
    // It must not publish a failure while that owner may still return a
    // definitive provider result. Broker retry/DLQ visibility preserves the
    // duplicate; the long-aged watchdog quarantines a genuinely abandoned
    // claim without invoking Email Service again.
    structuredLog('warn', 'email.outbound.inflight_owned', { xmtpMessageId: row.xmtp_msg_id });
    return { action: 'retry', error: 'outbound_inflight_owned' };
  }

  const claimed = await claimOutboundRequest(env, row.xmtp_msg_id);
  if (!claimed) return { action: 'retry', error: 'outbound_claim_conflict' };

  let email: EmailMessageBuilder;
  try {
    const to = parseAddressArray(row.to_email, 'to');
    const cc = parseAddressArray(row.cc_email, 'cc');
    const bcc = parseAddressArray(row.bcc_email, 'bcc');
    email = {
      from: requireEmailFrom(env.EMAIL_FROM),
      to,
      subject: row.subject ?? '',
      headers: { 'X-XMTP-Relay-Key': stableHeaderValue(row.xmtp_msg_id) },
    };
    if (cc.length > 0) email.cc = cc;
    if (bcc.length > 0) email.bcc = bcc;
    if (row.reply_to) email.replyTo = row.reply_to;
    if (row.text !== null) email.text = row.text;
    if (row.html !== null) email.html = row.html;
    if (row.text === null && row.html === null) email.text = '';
  } catch (error) {
    const detail = errorMessage(error);
    const failed = await markOutboundFailed(
      env,
      row.xmtp_msg_id,
      'failed',
      `invalid_stored_request:${detail}`,
    );
    const result = emailSendResultForRow(failed);
    if (result) await enqueueResult(env, failed, result);
    structuredLog('error', 'email.outbound.invalid_stored_request', {
      xmtpMessageId: row.xmtp_msg_id,
      error: detail,
    });
    return { action: 'ack' };
  }

  let providerResult: EmailSendResult;
  try {
    providerResult = await env.EMAIL.send(email);
  } catch (error) {
    const code = errorCode(error);
    const detail = errorMessage(error);
    if (code && PERMANENT_EMAIL_ERROR_CODES.has(code)) {
      const failed = await markOutboundFailed(env, row.xmtp_msg_id, 'failed', code);
      const result = emailSendResultForRow(failed);
      if (result) await enqueueResult(env, failed, result);
      structuredLog('error', 'email.outbound.permanent_failure', {
        xmtpMessageId: row.xmtp_msg_id,
        code,
        error: detail,
      });
      return { action: 'ack' };
    }

    if (!code || !TRANSIENT_EMAIL_ERROR_CODES.has(code)) {
      // An undocumented exception can occur after provider acceptance. Do not
      // resend automatically: Email Service has no idempotency key and controls
      // Message-ID, so retrying this crash window could duplicate real email.
      const uncertain = await markOutboundFailed(
        env,
        row.xmtp_msg_id,
        'uncertain',
        `delivery_state_unknown:${detail}`,
      );
      const result = emailSendResultForRow(uncertain);
      if (result) await enqueueResult(env, uncertain, result);
      structuredLog('error', 'email.outbound.quarantined', {
        xmtpMessageId: row.xmtp_msg_id,
        error: detail,
      });
      return { action: 'ack' };
    }

    if (isFinalAttempt(attempts, env)) {
      const failed = await markOutboundFailed(env, row.xmtp_msg_id, 'failed', `${code}:${detail}`);
      const result = emailSendResultForRow(failed);
      if (result) await enqueueResult(env, failed, result);
      // Persist visibility before asking Queue to perform its final retry. The
      // DLQ consumer upserts the same logical row once the broker moves it.
      await recordQueueFailure(env, queueName, row.xmtp_msg_id, attempts, detail);
    } else {
      await markOutboundRetry(env, row.xmtp_msg_id, `${code}:${detail}`);
    }
    structuredLog('warn', 'email.outbound.retry', {
      xmtpMessageId: row.xmtp_msg_id,
      attempts,
      code,
      error: detail,
    });
    return { action: 'retry', error: detail };
  }

  // Commit provider acceptance before doing any secondary bookkeeping. Once
  // this row is `sent`, a later Queue/D1 observability failure must never move
  // it back to `sending`/`uncertain` or invoke Email Service again.
  let sent: OutboundRow;
  try {
    sent = await markOutboundSent(env, row.xmtp_msg_id, providerResult.messageId);
  } catch (error) {
    const detail = errorMessage(error);
    structuredLog('error', 'email.outbound.provider_accepted_commit_failed', {
      xmtpMessageId: row.xmtp_msg_id,
      providerMessageId: providerResult.messageId,
      error: detail,
    });
    // A retry will observe `sending` and defer to the long-aged quarantine
    // rather than invoking Email Service again.
    return { action: 'retry', error: detail };
  }

  try {
    if (sent.status !== 'sent') {
      const result = emailSendResultForRow(sent);
      if (result) await enqueueResult(env, sent, result);
      structuredLog('error', 'email.outbound.provider_acceptance_state_conflict', {
        xmtpMessageId: row.xmtp_msg_id,
        providerMessageId: providerResult.messageId,
        actualStatus: sent.status,
      });
      return { action: 'ack' };
    }
    await setRelayState(env, 'last_outbound_email_delivered', {
      xmtpMessageId: row.xmtp_msg_id,
      providerMessageId: providerResult.messageId,
      deliveredAt: new Date().toISOString(),
    });
    const result = emailSendResultForRow(sent);
    if (result) await enqueueResult(env, sent, result);
  } catch (error) {
    const detail = errorMessage(error);
    structuredLog('warn', 'email.outbound.post_send_reconcile_needed', {
      xmtpMessageId: row.xmtp_msg_id,
      providerMessageId: providerResult.messageId,
      error: detail,
    });
    // Leave the durable status as `sent`; replay only repairs bookkeeping and
    // enqueues email.send.result.v1 via the early `sent` branch above.
    return { action: 'retry', error: detail };
  }

  structuredLog('info', 'email.outbound.sent', {
    xmtpMessageId: row.xmtp_msg_id,
    providerMessageId: providerResult.messageId,
  });
  return { action: 'ack' };
}

export async function processXmtpDeliveryJob(
  message: XmtpDeliveryQueueMessage,
  attempts: number,
  queueName: string,
  env: RelayEnv,
): Promise<QueueAction> {
  const watchdogPause = await getRelayState<unknown>(env, 'watchdog_pause');
  if (!isWatchdogActivationState(watchdogPause)) {
    structuredLog('error', 'xmtp.delivery.activation_required', { jobId: message.jobId });
    return { action: 'retry', error: 'container_activation_not_configured' };
  }
  if (watchdogPause.paused) {
    structuredLog('warn', 'xmtp.delivery.paused', { jobId: message.jobId });
    return { action: 'retry', error: 'container_watchdog_paused' };
  }

  const row = await getDeliveryJob(env, message.jobId);
  if (!row) {
    structuredLog('error', 'xmtp.delivery.missing_record', { jobId: message.jobId });
    return { action: 'ack' };
  }
  if (row.status === 'delivered') {
    if (row.kind === 'email.inbound.v1') {
      await setRelayState(env, 'last_inbound_email_delivered', {
        inboundId: Number(row.record_key),
        xmtpMessageId: row.xmtp_message_id,
        deliveredAt: row.delivered_at,
      });
    }
    return { action: 'ack' };
  }
  if (row.status === 'failed' || row.status === 'uncertain') {
    return { action: 'ack' };
  }
  if (row.status === 'delivering') {
    // Do not race an active Container request with a stale duplicate. As with
    // outbound email, only the long-aged watchdog may convert an abandoned
    // in-flight claim to `uncertain`.
    structuredLog('warn', 'xmtp.delivery.inflight_owned', { jobId: row.job_id });
    return { action: 'retry', error: 'xmtp_delivery_inflight_owned' };
  }

  const claimed = await claimDeliveryJob(env, row.job_id);
  if (!claimed) return { action: 'retry', error: 'delivery_claim_conflict' };

  const payload = parseDeliveryPayload(row);
  const requestBody: ContainerDeliveryRequest = {
    jobId: row.job_id,
    kind: row.kind,
    payload,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    ...(row.recipient_inbox_id ? { recipientInboxId: row.recipient_inbox_id } : {}),
    ...(row.sender_inbox_id ? { senderInboxId: row.sender_inbox_id } : {}),
  };

  let response: Response;
  try {
    const container = relayContainer(env);
    response = await container.fetch(new Request('http://container/internal/v1/xmtp/deliver', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CONTAINER_SHARED_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(120_000),
    }));
  } catch (error) {
    const detail = errorMessage(error);
    // A transport exception after the Container accepted the request is
    // ambiguous. Quarantine instead of risking duplicate XMTP mail.
    await markDeliveryUncertain(env, row.job_id, `delivery_state_unknown:${detail}`);
    structuredLog('error', 'xmtp.delivery.quarantined', { jobId: row.job_id, error: detail });
    return { action: 'ack' };
  }

  if (response.ok) {
    const responseBody = await safeJson(response);
    const xmtpMessageId = stringProperty(responseBody, 'messageId')
      ?? stringProperty(responseBody, 'xmtpMessageId');
    if (
      !responseBody
      || typeof responseBody !== 'object'
      || (responseBody as { ok?: unknown }).ok !== true
      || !xmtpMessageId?.trim()
      || xmtpMessageId.length > 512
    ) {
      await markDeliveryUncertain(env, row.job_id, 'delivery_state_unknown:invalid_container_success_response');
      structuredLog('error', 'xmtp.delivery.invalid_success_response', { jobId: row.job_id });
      return { action: 'ack' };
    }
    const completed = await markDeliveryComplete(env, row, xmtpMessageId);
    if (completed.status !== 'delivered') {
      structuredLog('error', 'xmtp.delivery.completion_state_conflict', {
        jobId: row.job_id,
        actualStatus: completed.status,
        xmtpMessageId,
      });
      return { action: 'ack' };
    }
    if (row.kind === 'email.inbound.v1') {
      await setRelayState(env, 'last_inbound_email_delivered', {
        inboundId: Number(row.record_key),
        xmtpMessageId,
        deliveredAt: new Date().toISOString(),
      });
    }
    structuredLog('info', 'xmtp.delivery.sent', {
      jobId: row.job_id,
      kind: row.kind,
      xmtpMessageId,
    });
    return { action: 'ack' };
  }

  const responseText = (await response.text()).slice(0, 1_000);
  const detail = `container_${response.status}:${responseText}`;
  if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
    await markDeliveryFailed(env, row.job_id, detail);
    await recordQueueFailure(env, queueName, row.job_id, attempts, detail);
    structuredLog('error', 'xmtp.delivery.permanent_failure', { jobId: row.job_id, error: detail });
    return { action: 'ack' };
  }

  if (response.status !== 503) {
    // The Container contract reserves 503 for failure before a child delivery
    // was accepted (not ready/not connected). A timeout/other 5xx can occur
    // after XMTP accepted the send and is therefore not safe to replay.
    await markDeliveryUncertain(env, row.job_id, `delivery_state_unknown:${detail}`);
    structuredLog('error', 'xmtp.delivery.quarantined', { jobId: row.job_id, error: detail });
    return { action: 'ack' };
  }

  if (isFinalAttempt(attempts, env)) {
    await markDeliveryFailed(env, row.job_id, detail);
    await recordQueueFailure(env, queueName, row.job_id, attempts, detail);
  } else {
    await markDeliveryRetry(env, row.job_id, detail);
  }
  structuredLog('warn', 'xmtp.delivery.retry', { jobId: row.job_id, attempts, error: detail });
  return { action: 'retry', error: detail };
}

async function enqueueResult(env: RelayEnv, row: OutboundRow, result: EmailSendResultV1): Promise<void> {
  const job = await createResultDeliveryJob(env, row, result);
  if (job.status !== 'received') return;
  await env.XMTP_DELIVERY_QUEUE.send({ version: 1, kind: 'xmtp_delivery', jobId: job.job_id });
  await markDeliveryQueued(env, job.job_id);
}

export function emailSendResultForRow(row: OutboundRow): EmailSendResultV1 | null {
  if (row.status === 'sent') {
    return makeEmailSendResult({ ok: true, providerMessageId: row.provider_message_id });
  }
  if (
    row.status !== 'failed'
    && row.status !== 'uncertain'
    && row.status !== 'denied'
    && row.status !== 'invalid'
  ) return null;

  let error = row.error ?? row.status;
  if (row.status === 'uncertain') error = 'delivery_state_unknown';
  else if (error.startsWith('invalid_stored_request:')) error = 'invalid_stored_request';
  else if (/^E_[A-Z_]+:/.test(error)) error = error.slice(0, error.indexOf(':'));
  return makeEmailSendResult({ ok: false, error });
}

function relayContainer(env: RelayEnv) {
  return getContainer<XmtpRelayContainer>(
    env.XMTP_RELAY as unknown as DurableObjectNamespace<XmtpRelayContainer>,
    configuredContainerName(env),
  );
}

function parseAddressArray(value: string | null, name: string): string[] {
  if (!value) {
    if (name === 'to') throw new Error('stored outbound request has no To recipients');
    return [];
  }
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`stored ${name} recipients are invalid`);
  }
  return parsed;
}

function requireEmailFrom(value: string): string | EmailAddress {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || /[\r\n\0]/.test(trimmed)) throw new Error('EMAIL_FROM is missing or invalid');
  if (isEmailAddress(trimmed)) return trimmed;

  const named = /^(.*?)\s*<([^<>]+)>$/.exec(trimmed);
  const name = named?.[1]?.trim() ?? '';
  const email = named?.[2]?.trim() ?? '';
  if (!name || new TextEncoder().encode(name).byteLength > 256 || !isEmailAddress(email)) {
    throw new Error('EMAIL_FROM is missing or invalid');
  }
  return { name, email };
}

function stableHeaderValue(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 2_048);
}

function parseDeliveryPayload(row: DeliveryJobRow): EmailInboundV1 | EmailSendResultV1 {
  const parsed: unknown = JSON.parse(row.payload_json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored delivery payload is invalid');
  }
  return parsed as EmailInboundV1 | EmailSendResultV1;
}

function isEmailDeliveryMessage(value: unknown): value is EmailDeliveryQueueMessage {
  if (!value || typeof value !== 'object') return false;
  const body = value as Partial<EmailDeliveryQueueMessage>;
  return body.version === 1 && body.kind === 'email_delivery' && typeof body.xmtpMessageId === 'string';
}

function isXmtpDeliveryMessage(value: unknown): value is XmtpDeliveryQueueMessage {
  if (!value || typeof value !== 'object') return false;
  const body = value as Partial<XmtpDeliveryQueueMessage>;
  return body.version === 1 && body.kind === 'xmtp_delivery' && typeof body.jobId === 'string';
}

function isFinalAttempt(attempts: number, env: RelayEnv): boolean {
  const maxRetries = envInteger(env.QUEUE_MAX_RETRIES, 8, { min: 0, max: 100 });
  return attempts >= maxRetries + 1;
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(3_600, 5 * (2 ** Math.min(attempts, 9)));
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function stringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || !(key in value)) return null;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : null;
}
