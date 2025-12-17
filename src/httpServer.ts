import crypto from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import rateLimit from 'express-rate-limit';
import type { RelayDb } from './db';
import { log } from './log';
import { normalizeMailgunInbound, verifyMailgunWebhookSignature } from './mailgun';
import { parseMailgunInboundForm } from './mailgunWebhook';

export type HttpServerDeps = {
  db: RelayDb;
  port: number;
  inboundEmailTo: string;
  mailgunWebhookSigningKey: string;
  enqueueInboundEmail: (id: number) => void;
  webhookRateLimit: { windowMs: number; max: number };
  maxInboundFieldSizeBytes: number;
};

export async function startHttpServer(deps: HttpServerDeps): Promise<Server> {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: true, limit: Math.max(1, deps.maxInboundFieldSizeBytes) }));

  app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    (req as RequestWithId).id = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const limiter = rateLimit({
    windowMs: deps.webhookRateLimit.windowMs,
    max: deps.webhookRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.post('/webhooks/mailgun/inbound', limiter, async (req, res) => {
    const requestId = (req as RequestWithId).id;
    let fields: Record<string, string>;
    try {
      fields = await parseMailgunInboundForm(req, {
        maxFieldSizeBytes: deps.maxInboundFieldSizeBytes,
      });
    } catch (error) {
      log.warn({ requestId, error }, 'mailgun.inbound.parse_failed');
      res.status(400).json({ ok: false, error: 'invalid_payload' });
      return;
    }

    const timestamp = fields.timestamp || '';
    const token = fields.token || '';
    const signature = fields.signature || '';
    const ok = timestamp && token && signature
      ? verifyMailgunWebhookSignature({
          signingKey: deps.mailgunWebhookSigningKey,
          timestamp,
          token,
          signature,
        })
      : false;

    if (!ok) {
      log.warn({ requestId }, 'mailgun.inbound.invalid_signature');
      res.status(403).json({ ok: false, error: 'invalid_signature' });
      return;
    }

    const normalized = normalizeMailgunInbound(fields);
    if (!normalized.to || !normalized.from) {
      log.warn({ requestId }, 'mailgun.inbound.missing_fields');
      res.status(400).json({ ok: false, error: 'missing_fields' });
      return;
    }

    if (deps.inboundEmailTo && normalized.to.toLowerCase() !== deps.inboundEmailTo.toLowerCase()) {
      log.info({ requestId, to: normalized.to }, 'mailgun.inbound.ignored_recipient');
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const receivedAt = new Date().toISOString();
    const inserted = deps.db.insertInboundEmail({
      mailgunMessageId: normalized.mailgunMessageId,
      messageId: normalized.messageId,
      from: normalized.from,
      to: normalized.to,
      subject: normalized.subject,
      text: normalized.text,
      html: normalized.html,
      receivedAt,
    });

    if (!inserted) {
      log.info({ requestId, messageId: normalized.messageId }, 'mailgun.inbound.duplicate');
      res.status(200).json({ ok: true, deduped: true });
      return;
    }

    deps.enqueueInboundEmail(inserted.id);
    log.info({ requestId, inboundId: inserted.id }, 'mailgun.inbound.enqueued');
    res.status(200).json({ ok: true });
  });

  return new Promise((resolve) => {
    const server = app.listen(deps.port, () => {
      log.info({ port: deps.port }, 'http.listening');
      resolve(server);
    });
  });
}

type RequestWithId = express.Request & { id: string };

