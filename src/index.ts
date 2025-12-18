import * as dotenv from 'dotenv';
import { ConsentState, type Client as XmtpClient, type Conversation, type DecodedMessage } from '@xmtp/node-sdk';
import { RelayDb } from './db';
import { loadConfig } from './config';
import { DedupingQueue, sleep } from './queue';
import { log } from './log';
import { makeEmailSendResultV1, emailSendV1Schema } from './messages';
import { sendEmailViaMailgun } from './mailgunSend';
import { startHttpServer, type PublicConfig } from './httpServer';
import { createEnsProvider, createXmtpClient, getInboxIdByAddress, resolveXmtpAddress } from './xmtp';

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfig();
  const db = RelayDb.open(config.dataDir);

  const provider = createEnsProvider(config.ethRpcUrl);

  const xmtp = await createXmtpClient({
    privateKey: config.xmtpBotKey,
    env: config.xmtpEnv,
    dataDir: config.dataDir,
  });

  log.info({ inboxId: xmtp.inboxId, address: xmtp.accountIdentifier?.identifier ?? null }, 'xmtp.ready');

  await xmtp.conversations.sync();

  const deanAddress = await resolveXmtpAddress(config.xmtpDeanAddressOrEns, provider);
  const deanInboxId = await getInboxIdByAddress({ xmtp, address: deanAddress });

  const allowlistResolvedAddresses = await Promise.all(
    config.xmtpAllowedSenders.map(async (value) => resolveXmtpAddress(value, provider)),
  );
  const allowlistInboxIds = await Promise.all(
    allowlistResolvedAddresses.map(async (address) => getInboxIdByAddress({ xmtp, address })),
  );
  db.seedAllowlist([deanInboxId, ...allowlistInboxIds].map((inboxId) => inboxId.toLowerCase()));

  if (config.adminXmtpAddressOrEns) {
    try {
      const adminAddress = await resolveXmtpAddress(config.adminXmtpAddressOrEns, provider);
      const adminInboxId = await getInboxIdByAddress({ xmtp, address: adminAddress });
      const convo = await xmtp.conversations.newDm(adminInboxId);
      convo.updateConsentState(ConsentState.Allowed);
      await convo.send(`XMTP-MX Relay started (${new Date().toISOString()})`);
    } catch (error) {
      log.warn({ error }, 'xmtp.admin_notify_failed');
    }
  }

  const inboundQueue = new DedupingQueue<number>();
  const refillInboundQueue = () => {
    for (const row of db.listUnsentInboundEmails(500)) inboundQueue.enqueue(row.id);
  };
  refillInboundQueue();

  const getDeanConversation = (() => {
    let cached: Conversation<any> | null = null;
    return async () => {
      if (cached) return cached;
      const convo = await xmtp.conversations.newDm(deanInboxId);
      convo.updateConsentState(ConsentState.Allowed);
      cached = convo;
      return convo;
    };
  })();

  startInboundDeliveryWorker({
    db,
    inboundQueue,
    getDeanConversation,
  });

  const publicConfig: PublicConfig = {
    port: config.port,
    dataDir: config.dataDir,
    inboundEmailTo: config.inboundEmailTo,
    xmtpEnv: config.xmtpEnv,
    xmtpDeanAddressOrEns: config.xmtpDeanAddressOrEns,
    adminXmtpAddressOrEns: config.adminXmtpAddressOrEns,
    ethRpcUrl: config.ethRpcUrl,
    mailgunDomain: config.mailgunDomain,
    mailgunFrom: config.mailgunFrom,
    webhookRateLimit: config.webhookRateLimit,
    maxInboundFieldSizeBytes: config.maxInboundFieldSizeBytes,
  };

  await startHttpServer({
    db,
    port: config.port,
    inboundEmailTo: config.inboundEmailTo,
    mailgunWebhookSigningKey: config.mailgunWebhookSigningKey,
    enqueueInboundEmail: (id) => inboundQueue.enqueue(id),
    webhookRateLimit: config.webhookRateLimit,
    maxInboundFieldSizeBytes: config.maxInboundFieldSizeBytes,
    publicConfig,
  });

  startXmtpOutboundLoop({
    db,
    xmtp,
    mailgun: {
      apiKey: config.mailgunApiKey,
      domain: config.mailgunDomain,
      from: config.mailgunFrom,
    },
  });
}

function startInboundDeliveryWorker(args: {
  db: RelayDb;
  inboundQueue: DedupingQueue<number>;
  getDeanConversation: () => Promise<Conversation<any>>;
}): void {
  const { db, inboundQueue, getDeanConversation } = args;

  // Refill on an interval so restarts/crashes don't drop work.
  setInterval(() => {
    for (const row of db.listUnsentInboundEmails(500)) inboundQueue.enqueue(row.id);
  }, 30_000).unref();

  void (async () => {
    while (true) {
      const id = inboundQueue.dequeue();
      if (id === null) {
        await sleep(250);
        continue;
      }

      const row = db.getInboundEmailById(id);
      if (!row || row.xmtp_sent_at) continue;

      const payload = {
        type: 'email.inbound.v1',
        to: row.to,
        from: row.from,
        subject: row.subject ?? '',
        text: row.text,
        html: row.html,
        messageId: row.message_id,
        receivedAt: row.received_at,
      };

      try {
        const conversation = await getDeanConversation();
        await conversation.send(JSON.stringify(payload));
        db.markInboundEmailSent(row.id, new Date().toISOString());
        log.info({ inboundId: row.id }, 'xmtp.inbound.sent');
      } catch (error) {
        log.error({ inboundId: row.id, error }, 'xmtp.inbound.send_failed');
        inboundQueue.enqueue(row.id);
        await sleep(2000);
      }
    }
  })();
}

function startXmtpOutboundLoop(args: {
  db: RelayDb;
  xmtp: XmtpClient<any>;
  mailgun: { apiKey: string; domain: string; from: string };
}): void {
  const { db, xmtp, mailgun } = args;

  void (async () => {
    while (true) {
      try {
        const stream = await xmtp.conversations.streamAllMessages(
          undefined,
          undefined,
          [ConsentState.Allowed, ConsentState.Unknown],
        );
        for await (const message of stream) {
          if (!message) continue;
          try {
            await handleXmtpMessage({ db, botInboxId: xmtp.inboxId, xmtp, message, mailgun });
          } catch (error) {
            log.error({ error, xmtpMsgId: message.id }, 'xmtp.message.handler_failed');
          }
        }
      } catch (error) {
        log.error({ error }, 'xmtp.stream.crashed');
        await sleep(5000);
      }
    }
  })();
}

async function handleXmtpMessage(args: {
  db: RelayDb;
  botInboxId: string;
  xmtp: XmtpClient<any>;
  message: DecodedMessage<any>;
  mailgun: { apiKey: string; domain: string; from: string };
}): Promise<void> {
  const { db, botInboxId, xmtp, message, mailgun } = args;

  const senderInboxId = message.senderInboxId.toLowerCase();
  if (senderInboxId === botInboxId.toLowerCase()) return;
  if (typeof message.content !== 'string') return;

  log.debug(
    {
      xmtpMsgId: message.id,
      senderInboxId,
      conversationId: message.conversationId,
      contentLength: message.content.length,
    },
    'xmtp.message.received',
  );

  const conversation = await xmtp.conversations.getConversationById(message.conversationId);
  if (!conversation) {
    log.warn({ xmtpMsgId: message.id, senderInboxId }, 'xmtp.message.conversation_not_found');
    return;
  }

  const content = message.content.trim();
  if (!content) return;

  const allowlisted = db.isAllowlisted(senderInboxId);

  if (isGreetingMessage(content)) {
    conversation.updateConsentState(ConsentState.Allowed);
    await conversation.send(buildIntroMessage({ allowlisted }));
    log.info({ xmtpMsgId: message.id, senderInboxId, allowlisted }, 'xmtp.message.replied_intro');
    return;
  }

  const parsedJson = parseJsonishMessage(content);
  if (!parsedJson) {
    conversation.updateConsentState(ConsentState.Allowed);
    await conversation.send(buildIntroMessage({ allowlisted }));
    log.info({ xmtpMsgId: message.id, senderInboxId, allowlisted, reason: 'non_json' }, 'xmtp.message.replied_help');
    return;
  }

  const type = (parsedJson as { type?: unknown } | null)?.type;
  if (type !== 'email.send.v1') {
    conversation.updateConsentState(ConsentState.Allowed);
    const header =
      typeof type === 'string'
        ? `Unrecognized message type: ${type}`
        : 'Unrecognized message type (missing `type`)';
    await conversation.send([header, '', buildIntroMessage({ allowlisted })].join('\n'));
    log.info(
      { xmtpMsgId: message.id, senderInboxId, allowlisted, type, reason: 'unknown_type' },
      'xmtp.message.replied_help',
    );
    return;
  }

  if (!allowlisted) {
    log.warn({ senderInboxId }, 'xmtp.outbound.denied');
    await conversation.send(JSON.stringify(makeEmailSendResultV1({ ok: false, error: 'not_allowlisted' })));
    return;
  }

  let request;
  try {
    request = emailSendV1Schema.parse(parsedJson);
  } catch (error) {
    log.warn({ senderInboxId, error }, 'xmtp.outbound.invalid_payload');
    await conversation.send(JSON.stringify(makeEmailSendResultV1({ ok: false, error: 'invalid_payload' })));
    return;
  }

  const existing = db.getOutboundRequestByXmtpMsgId(message.id);
  if (existing) {
    if (existing.status === 'sent') {
      await conversation.send(
        JSON.stringify(makeEmailSendResultV1({ ok: true, mailgunId: existing.mailgun_id })),
      );
      return;
    }
    if (existing.status === 'failed') {
      await conversation.send(
        JSON.stringify(makeEmailSendResultV1({ ok: false, mailgunId: existing.mailgun_id, error: existing.error })),
      );
      return;
    }
    await conversation.send(JSON.stringify(makeEmailSendResultV1({ ok: false, error: 'already_processing' })));
    return;
  }

  const now = new Date().toISOString();
  db.insertOutboundRequest({
    xmtpMsgId: message.id,
    fromInbox: senderInboxId,
    to: request.to,
    cc: request.cc,
    bcc: request.bcc,
    subject: request.subject || null,
    text: request.text,
    html: request.html,
    createdAt: now,
  });
  db.updateOutboundRequestStatus(message.id, { status: 'sending' }, new Date().toISOString());

  try {
    const result = await sendEmailViaMailgun({
      apiKey: mailgun.apiKey,
      domain: mailgun.domain,
      from: mailgun.from,
      to: request.to,
      cc: request.cc,
      bcc: request.bcc,
      subject: request.subject,
      text: request.text,
      html: request.html,
      replyTo: request.replyTo,
    });

    db.updateOutboundRequestStatus(
      message.id,
      { status: 'sent', mailgunId: result.id ?? null, error: null },
      new Date().toISOString(),
    );
    await conversation.send(JSON.stringify(makeEmailSendResultV1({ ok: true, mailgunId: result.id ?? null })));
    log.info({ senderInboxId, mailgunId: result.id ?? null }, 'mailgun.sent');
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    db.updateOutboundRequestStatus(
      message.id,
      { status: 'failed', error: errMsg },
      new Date().toISOString(),
    );
    await conversation.send(JSON.stringify(makeEmailSendResultV1({ ok: false, error: errMsg })));
    log.error({ senderInboxId, error }, 'mailgun.send_failed');
  }
}

function isGreetingMessage(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  // Avoid matching JSON payloads that happen to contain "hello".
  if (trimmed.startsWith('{') || trimmed.startsWith('```')) return false;

  const lower = trimmed.toLowerCase();
  if (lower === '?') return true;
  return /^(hello|hi|hey|help|start|info)(\b|[^a-z0-9])/i.test(lower);
}

function parseJsonishMessage(content: string): unknown | null {
  const direct = tryParseJson(content);
  if (direct !== null) return direct;

  const unfenced = stripMarkdownCodeFences(content);
  if (unfenced) {
    const parsed = tryParseJson(unfenced);
    if (parsed !== null) return parsed;
  }

  const extracted = extractJsonSubstring(content);
  if (extracted) {
    const parsed = tryParseJson(extracted);
    if (parsed !== null) return parsed;
  }

  return null;
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stripMarkdownCodeFences(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('```')) return null;
  const lastFenceIndex = trimmed.lastIndexOf('```');
  if (lastFenceIndex <= 0) return null;
  const firstNewlineIndex = trimmed.indexOf('\n');
  if (firstNewlineIndex < 0) return null;
  const inner = trimmed.slice(firstNewlineIndex + 1, lastFenceIndex).trim();
  return inner || null;
}

function extractJsonSubstring(value: string): string | null {
  const trimmed = value.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) return trimmed.slice(firstBrace, lastBrace + 1);
  return null;
}

function buildIntroMessage(args: { allowlisted: boolean }): string {
  const allowlistLine = args.allowlisted
    ? 'Your inbox is allowlisted for outbound email.'
    : 'Your inbox is NOT allowlisted for outbound email (ask the admin to add you).';

  const example = {
    type: 'email.send.v1',
    to: ['someone@example.com'],
    cc: [],
    bcc: [],
    subject: 'Hello from XMTP',
    text: 'This is a test email sent via the xmtp.mx relay bot.',
    html: null,
    replyTo: 'deanpierce.eth@xmtp.mx',
  };

  const replyExample = {
    type: 'email.send.result.v1',
    ok: true,
    mailgunId: '...',
    error: null,
  };

  return [
    'Hello — I am the xmtp.mx relay bot.',
    '',
    allowlistLine,
    '',
    'To send an email, send me a JSON message like:',
    JSON.stringify(example, null, 2),
    '',
    'Notes:',
    '- `type` must be `email.send.v1`',
    '- `to` is required (array of email strings)',
    '- `cc`, `bcc`, `subject`, `replyTo` are optional',
    '- Provide at least one of `text` or `html`',
    '',
    'I will reply with:',
    JSON.stringify(replyExample, null, 2),
  ].join('\n');
}

main().catch((error) => {
  log.error({ error }, 'fatal');
  process.exitCode = 1;
});
