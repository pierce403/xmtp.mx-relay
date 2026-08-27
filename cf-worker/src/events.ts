import { requireContainerAuth } from './auth';
import type { RelayEnv } from './bindings';
import {
  createResultDeliveryJob,
  getOutboundRequest,
  insertOutboundRequest,
  isAllowlisted,
  markDeliveryQueued,
  markOutboundQueued,
  seedConfiguredAllowlist,
  setRelayState,
} from './db';
import {
  InputError,
  makeEmailSendResult,
  parseEmailSendV1,
  parseXmtpEvent,
  type EmailSendResultV1,
} from './protocol';
import { envInteger, errorMessage, readJsonWithLimit, structuredLog } from './runtime';

export async function handleXmtpEventRequest(request: Request, env: RelayEnv): Promise<Response> {
  const unauthorized = requireContainerAuth(request, env);
  if (unauthorized) return unauthorized;
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  try {
    const maxRequestBytes = envInteger(env.MAX_INTERNAL_REQUEST_BYTES, 384 * 1024, {
      min: 16 * 1024,
      max: 2 * 1024 * 1024,
    });
    const maxContentBytes = envInteger(env.MAX_RELAY_BODY_BYTES, 256 * 1024, {
      min: 4 * 1024,
      max: 1024 * 1024,
    });
    const body = await readJsonWithLimit(request, maxRequestBytes);
    const event = parseXmtpEvent(body, maxContentBytes);
    try {
      await setRelayState(env, 'last_xmtp_message_received', {
        messageId: event.messageId,
        senderInboxId: event.senderInboxId,
        receivedAt: event.receivedAt,
      });
    } catch (error) {
      // Observability is not the ingestion boundary and must not wedge the
      // ordered live stream or an already-durable replay.
      structuredLog('warn', 'xmtp.event.observability_deferred', {
        xmtpMessageId: event.messageId,
        error: errorMessage(error),
      });
    }

    const existing = await getOutboundRequest(env, event.messageId);
    if (existing) {
      try {
        if (existing.status === 'received') {
          await env.EMAIL_DELIVERY_QUEUE.send({
            version: 1,
            kind: 'email_delivery',
            xmtpMessageId: event.messageId,
          });
          await markOutboundQueued(env, event.messageId);
        } else if (existing.status === 'denied' || existing.status === 'invalid') {
          await enqueueResult(env, existing, makeEmailSendResult({
            ok: false,
            error: existing.error ?? (existing.status === 'denied' ? 'not_allowlisted' : 'invalid_payload'),
          }));
        } else if (existing.status === 'sent') {
          await enqueueResult(env, existing, makeEmailSendResult({
            ok: true,
            providerMessageId: existing.provider_message_id,
          }));
        } else if (existing.status === 'failed' || existing.status === 'uncertain') {
          await enqueueResult(env, existing, makeEmailSendResult({
            ok: false,
            error: existing.error ?? existing.status,
          }));
        }
      } catch (error) {
        structuredLog('error', 'xmtp.event.handoff_deferred', {
          xmtpMessageId: event.messageId,
          status: existing.status,
          error: errorMessage(error),
        });
      }
      structuredLog('info', 'xmtp.event.duplicate', {
        xmtpMessageId: event.messageId,
        status: existing.status,
      });
      return json({ ok: true, deduped: true, status: existing.status }, 200);
    }

    await seedConfiguredAllowlist(env);
    const allowlisted = await isAllowlisted(env, event.senderInboxId);
    if (!allowlisted) {
      const inserted = await insertOutboundRequest(env, event, null, 'denied', 'not_allowlisted');
      if (inserted.inserted) {
        try {
          await enqueueResult(env, inserted.row, makeEmailSendResult({ ok: false, error: 'not_allowlisted' }));
        } catch (error) {
          structuredLog('error', 'xmtp.event.handoff_deferred', {
            xmtpMessageId: event.messageId,
            status: inserted.row.status,
            error: errorMessage(error),
          });
        }
      }
      structuredLog('warn', 'xmtp.outbound.denied', {
        xmtpMessageId: event.messageId,
        senderInboxId: event.senderInboxId,
      });
      // The authenticated Container has successfully handed this durable event
      // to the edge. Denial is the relay outcome, not an ingestion failure;
      // return 2xx so the live XMTP stream can advance to later messages.
      return json({ ok: true, accepted: true, outcome: 'denied', error: 'not_allowlisted' }, 202);
    }

    let emailRequest;
    try {
      emailRequest = parseEmailSendV1(event.content, maxContentBytes);
    } catch (error) {
      const code = error instanceof InputError ? error.code : 'invalid_payload';
      const inserted = await insertOutboundRequest(env, event, null, 'invalid', code);
      if (inserted.inserted) {
        try {
          await enqueueResult(env, inserted.row, makeEmailSendResult({ ok: false, error: code }));
        } catch (handoffError) {
          structuredLog('error', 'xmtp.event.handoff_deferred', {
            xmtpMessageId: event.messageId,
            status: inserted.row.status,
            error: errorMessage(handoffError),
          });
        }
      }
      structuredLog('warn', 'xmtp.outbound.invalid_payload', {
        xmtpMessageId: event.messageId,
        senderInboxId: event.senderInboxId,
        error: errorMessage(error),
      });
      return json({ ok: true, accepted: true, outcome: 'invalid', error: code }, 202);
    }

    const inserted = await insertOutboundRequest(env, event, emailRequest, 'received', null);
    if (!inserted.inserted) return json({ ok: true, deduped: true, status: inserted.row.status }, 200);

    try {
      await env.EMAIL_DELIVERY_QUEUE.send({
        version: 1,
        kind: 'email_delivery',
        xmtpMessageId: event.messageId,
      });
      await markOutboundQueued(env, event.messageId);
      structuredLog('info', 'xmtp.outbound.queued', {
        xmtpMessageId: event.messageId,
        senderInboxId: event.senderInboxId,
      });
      return json({ ok: true, queued: true }, 202);
    } catch (error) {
      // The outbound_request row is the durable acceptance boundary. The
      // watchdog repairs the D1-to-Queue handoff without wedging the ordered
      // XMTP stream on an already-persisted event.
      structuredLog('error', 'xmtp.event.handoff_deferred', {
        xmtpMessageId: event.messageId,
        status: inserted.row.status,
        error: errorMessage(error),
      });
      return json({ ok: true, accepted: true, queued: false, deferred: true }, 202);
    }
  } catch (error) {
    if (error instanceof InputError) {
      return json({ ok: false, error: error.code }, error.code === 'payload_too_large' ? 413 : 400);
    }
    structuredLog('error', 'xmtp.event.failed', { error: errorMessage(error) });
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}

async function enqueueResult(
  env: RelayEnv,
  row: Awaited<ReturnType<typeof insertOutboundRequest>>['row'],
  result: EmailSendResultV1,
): Promise<void> {
  const job = await createResultDeliveryJob(env, row, result);
  if (job.status !== 'received') return;
  await env.XMTP_DELIVERY_QUEUE.send({ version: 1, kind: 'xmtp_delivery', jobId: job.job_id });
  await markDeliveryQueued(env, job.job_id);
}

function json(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}
