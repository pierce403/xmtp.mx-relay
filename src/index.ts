import * as dotenv from 'dotenv';
import { ConsentState, type Client as XmtpClient, type Conversation, type DecodedMessage } from '@xmtp/node-sdk';
import { RelayDb } from './db';
import { loadConfig } from './config';
import { DedupingQueue, sleep } from './queue';
import { log } from './log';
import { makeEmailSendResultV1, emailSendV1Schema } from './messages';
import { sendEmailViaMailgun } from './mailgunSend';
import { startHttpServer } from './httpServer';
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

  await startHttpServer({
    db,
    port: config.port,
    inboundEmailTo: config.inboundEmailTo,
    mailgunWebhookSigningKey: config.mailgunWebhookSigningKey,
    enqueueInboundEmail: (id) => inboundQueue.enqueue(id),
    webhookRateLimit: config.webhookRateLimit,
    maxInboundFieldSizeBytes: config.maxInboundFieldSizeBytes,
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
          await handleXmtpMessage({ db, botInboxId: xmtp.inboxId, xmtp, message, mailgun });
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

  const conversation = await xmtp.conversations.getConversationById(message.conversationId);
  if (!conversation) return;

  if (isGreetingMessage(message.content)) {
    const allowlisted = db.isAllowlisted(senderInboxId);
    conversation.updateConsentState(ConsentState.Allowed);
    await conversation.send(buildIntroMessage({ allowlisted }));
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(message.content);
  } catch {
    return;
  }

  const type = (parsedJson as { type?: unknown } | null)?.type;
  if (type !== 'email.send.v1') return;

  if (!db.isAllowlisted(senderInboxId)) {
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
  if (trimmed.startsWith('{')) return false;

  const lower = trimmed.toLowerCase();
  if (lower === 'hello' || lower === 'hi' || lower === 'hey' || lower === 'help') return true;
  if (lower.startsWith('hello ')) return true;
  if (lower.startsWith('hi ')) return true;
  if (lower.startsWith('hey ')) return true;
  return false;
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
