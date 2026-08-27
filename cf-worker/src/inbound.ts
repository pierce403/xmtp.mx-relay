import PostalMime from 'postal-mime';
import type { RelayEnv } from './bindings';
import {
  createInboundDeliveryJob,
  insertInboundEmail,
  markDeliveryQueued,
  resolveThreadId,
  setRelayState,
} from './db';
import { isEmailAddress, utf8Length, type EmailInboundV1 } from './protocol';
import { envInteger, errorMessage, structuredLog } from './runtime';

export async function handleInboundEmail(message: ForwardableEmailMessage, env: RelayEnv): Promise<void> {
  let durableInboundId: number | null = null;
  const configuredRecipient = env.INBOUND_EMAIL_TO.trim().toLowerCase();
  if (!configuredRecipient || message.to.trim().toLowerCase() !== configuredRecipient) {
    structuredLog('warn', 'email.inbound.unexpected_recipient', { to: message.to });
    message.setReject('Recipient is not configured for this relay');
    return;
  }

  if (!isEmailAddress(message.from) || !isEmailAddress(message.to)) {
    message.setReject('Invalid SMTP envelope address');
    return;
  }

  const maxRawBytes = envInteger(env.MAX_INBOUND_EMAIL_BYTES, 5 * 1024 * 1024, {
    min: 64 * 1024,
    max: 10 * 1024 * 1024,
  });
  if (message.rawSize > maxRawBytes) {
    structuredLog('warn', 'email.inbound.too_large', { rawSize: message.rawSize, maxRawBytes });
    message.setReject('Message exceeds the relay size limit');
    return;
  }

  try {
    const raw = await new Response(message.raw).arrayBuffer();
    if (raw.byteLength > maxRawBytes) {
      message.setReject('Message exceeds the relay size limit');
      return;
    }

    const parsed = await PostalMime.parse(raw, {
      rfc822Attachments: false,
      maxNestingDepth: 20,
      maxHeadersSize: 128 * 1024,
      maxRfc822NestingDepth: 3,
    });
    const maxBodyBytes = envInteger(env.MAX_RELAY_BODY_BYTES, 256 * 1024, {
      min: 4 * 1024,
      max: 1024 * 1024,
    });
    const text = parsed.text ?? null;
    const html = parsed.html ?? null;
    if (utf8Length(text ?? '') + utf8Length(html ?? '') > maxBodyBytes) {
      structuredLog('warn', 'email.inbound.body_too_large', { maxBodyBytes });
      message.setReject('Decoded message body exceeds the relay size limit');
      return;
    }

    const rawMessageId = parsed.messageId ?? message.headers.get('message-id');
    const messageId = normalizeMessageId(rawMessageId);
    // Message-ID is sender-controlled and is not unique enough to be a
    // security boundary. Hash the SMTP envelope plus exact raw message so a
    // Cloudflare replay collapses while distinct messages that reuse or spoof
    // a Message-ID are still delivered independently.
    const dedupeKey = await computeInboundDedupeKey(message.from, message.to, raw);
    const inReplyTo = normalizeMessageId(parsed.inReplyTo ?? message.headers.get('in-reply-to'));
    const threadId = await resolveThreadId(env, messageId, inReplyTo, dedupeKey);
    const receivedAt = new Date().toISOString();
    const subject = sanitizeSubject(parsed.subject ?? message.headers.get('subject') ?? '');
    const serializedPayloadBytes = serializedInboundPayloadBytes({
      type: 'email.inbound.v1',
      to: message.to.trim(),
      from: message.from.trim(),
      subject,
      text,
      html,
      messageId,
      receivedAt,
    });
    if (serializedPayloadBytes > maxBodyBytes) {
      structuredLog('warn', 'email.inbound.xmtp_payload_too_large', {
        serializedPayloadBytes,
        maxBodyBytes,
      });
      message.setReject('Normalized XMTP message exceeds the relay size limit');
      return;
    }

    const inserted = await insertInboundEmail(env, {
      dedupeKey,
      messageId,
      envelopeFrom: message.from.trim(),
      envelopeTo: message.to.trim(),
      headerFrom: boundedHeader(message.headers.get('from')),
      headerTo: boundedHeader(message.headers.get('to')),
      subject,
      text,
      html,
      threadId,
      receivedAt,
    });
    durableInboundId = inserted.row.id;

    if (!inserted.inserted && inserted.row.status === 'delivered') {
      structuredLog('info', 'email.inbound.duplicate', { dedupeKey, status: inserted.row.status });
      return;
    }

    const job = await createInboundDeliveryJob(env, inserted.row);
    if (job.status === 'received') {
      await env.XMTP_DELIVERY_QUEUE.send({ version: 1, kind: 'xmtp_delivery', jobId: job.job_id });
      await markDeliveryQueued(env, job.job_id);
    }
    await setRelayState(env, 'last_inbound_email_received', {
      inboundId: inserted.row.id,
      messageId,
      receivedAt,
    });
    structuredLog('info', inserted.inserted ? 'email.inbound.queued' : 'email.inbound.duplicate_requeued', {
      inboundId: inserted.row.id,
      dedupeKey,
    });
  } catch (error) {
    if (durableInboundId !== null) {
      // The source event is already durable and the watchdog can reconstruct a
      // missing delivery_job or re-enqueue an existing one. Acknowledging here
      // prevents Cloudflare Email Routing retries from becoming the outbox.
      structuredLog('error', 'email.inbound.handoff_deferred', {
        inboundId: durableInboundId,
        error: errorMessage(error),
      });
      return;
    }
    structuredLog('error', 'email.inbound.failed', { error: errorMessage(error) });
    // No durable source row was confirmed, so leave the SMTP event
    // unacknowledged and let Cloudflare retry it.
    throw error;
  }
}

function normalizeMessageId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  if (!normalized || utf8Length(normalized) > 512 || /[\r\n\0]/.test(normalized)) return null;
  return normalized;
}

function boundedHeader(value: string | null): string | null {
  if (!value) return null;
  const unfolded = value.replace(/[\r\n]+[ \t]*/g, ' ').trim();
  return utf8Length(unfolded) <= 2_048 ? unfolded : null;
}

function sanitizeSubject(value: string): string {
  const unfolded = value.replace(/[\r\n]+[ \t]*/g, ' ').replace(/\0/g, '').trim();
  if (utf8Length(unfolded) <= 2_048) return unfolded;
  return new TextDecoder().decode(new TextEncoder().encode(unfolded).slice(0, 2_048));
}

export async function computeInboundDedupeKey(
  from: string,
  to: string,
  raw: ArrayBuffer,
): Promise<string> {
  const prefix = new TextEncoder().encode(`${from.trim().toLowerCase()}\n${to.trim().toLowerCase()}\n`);
  const bytes = new Uint8Array(prefix.byteLength + raw.byteLength);
  bytes.set(prefix, 0);
  bytes.set(new Uint8Array(raw), prefix.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

export function serializedInboundPayloadBytes(payload: EmailInboundV1): number {
  return utf8Length(JSON.stringify(payload));
}
