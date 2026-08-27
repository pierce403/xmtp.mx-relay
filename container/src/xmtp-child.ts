import crypto from 'node:crypto';
import fs from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  Client,
  ConsentState,
  IdentifierKind,
  SortDirection,
  generateInboxId,
  getInboxIdForIdentifier,
  type AsyncStream,
  type Conversation,
  type DecodedMessage,
  type Identifier,
  type Signer,
} from '@xmtp/node-sdk';
import { ethers } from 'ethers';
import { BoundedRecentSet } from './bounded-recent-set.js';
import { loadConfig, type ContainerConfig } from './config.js';
import { assertIdentityStoragePreconditions } from './identity-safety.js';
import { canonicalizeEmailSendEventContent } from './jsonish.js';
import { createLogger } from './log.js';
import {
  type ChildToParentMessage,
  type DeliveryRequest,
  type EdgeXmtpEvent,
  type ParentToChildMessage,
} from './protocol.js';
import { PINNED_INBOX_FILENAME, RecoveryRequiredError, databasePath } from './snapshot.js';
import { retryUntilSuccess } from './retry.js';

const config = loadConfig();
const log = createLogger(config.logLevel).child({ processRole: 'xmtp-child' });
const replayAfter = process.env.XMTP_REPLAY_AFTER_ISO ?? new Date(0).toISOString();

let xmtp: Client<any> | null = null;
let deanInboxId: string | null = null;
let activeStream: AsyncStream<DecodedMessage<any>> | null = null;
let stopping = false;
let shutdownPromise: Promise<void> | null = null;
const edgeAbortController = new AbortController();
const inFlight = new Set<Promise<unknown>>();
const seenMessageIds = new BoundedRecentSet(50_000);

function sendParent(message: ChildToParentMessage): void {
  if (process.connected) process.send?.(message);
}

function normalizePrivateKey(privateKey: string): string {
  const trimmed = privateKey.trim();
  if (!trimmed) throw new Error('XMTP_BOT_KEY is empty');
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

function makeEthereumIdentifier(address: string): Identifier {
  return { identifier: ethers.utils.getAddress(address), identifierKind: IdentifierKind.Ethereum };
}

function deriveDbEncryptionKey(privateKeyHex: string): Uint8Array {
  return crypto.createHash('sha256').update(ethers.utils.arrayify(privateKeyHex)).digest();
}

async function readPinnedInboxId(dataDir: string): Promise<string | null> {
  try {
    const value = (await fs.promises.readFile(path.join(dataDir, PINNED_INBOX_FILENAME), 'utf8'))
      .trim()
      .toLowerCase();
    return value || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writePinnedInboxId(dataDir: string, inboxId: string): Promise<void> {
  const destination = path.join(dataDir, PINNED_INBOX_FILENAME);
  const existing = await readPinnedInboxId(dataDir);
  if (existing) {
    if (existing !== inboxId) throw new RecoveryRequiredError('Client.inboxId differs from pinned inbox file');
    return;
  }
  const temporary = `${destination}.new-${process.pid}`;
  await writeFile(temporary, `${inboxId}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, destination);
}

async function resolveXmtpAddress(value: string, provider: ethers.providers.Provider): Promise<string> {
  const trimmed = value.trim();
  if (ethers.utils.isAddress(trimmed)) return ethers.utils.getAddress(trimmed);
  if (!trimmed.endsWith('.eth')) throw new Error(`Expected an Ethereum address or ENS name: ${value}`);
  const resolved = await provider.resolveName(trimmed);
  if (!resolved) throw new Error(`Failed to resolve ENS name: ${trimmed}`);
  return ethers.utils.getAddress(resolved);
}

async function createStrictXmtpClient(containerConfig: ContainerConfig): Promise<Client<any>> {
  await fs.promises.mkdir(containerConfig.dataDir, { recursive: true, mode: 0o700 });
  const privateKey = normalizePrivateKey(containerConfig.xmtpBotKey);
  const wallet = new ethers.Wallet(privateKey);
  const identifier = makeEthereumIdentifier(wallet.address);
  const signer: Signer = {
    type: 'EOA',
    signMessage: async (message) => ethers.utils.arrayify(await wallet.signMessage(message)),
    getIdentifier: () => identifier,
  };

  const registeredInboxId = await getInboxIdForIdentifier(identifier, containerConfig.xmtpEnv);
  const deterministicInboxId = (registeredInboxId || generateInboxId(identifier)).toLowerCase();
  if (
    containerConfig.xmtpExpectedInboxId &&
    deterministicInboxId !== containerConfig.xmtpExpectedInboxId
  ) {
    throw new RecoveryRequiredError(
      `network inbox ${deterministicInboxId} does not match XMTP_EXPECTED_INBOX_ID ${containerConfig.xmtpExpectedInboxId}`,
    );
  }

  const pinnedInboxId = await readPinnedInboxId(containerConfig.dataDir);
  if (pinnedInboxId && pinnedInboxId !== deterministicInboxId) {
    throw new RecoveryRequiredError(
      `pinned inbox ${pinnedInboxId} does not match wallet/network inbox ${deterministicInboxId}`,
    );
  }

  const inboxIdHint = pinnedInboxId || containerConfig.xmtpExpectedInboxId || deterministicInboxId;
  const dbPath = databasePath(containerConfig.dataDir, containerConfig.xmtpEnv, inboxIdHint);
  const databaseExists = fs.existsSync(dbPath);
  assertIdentityStoragePreconditions({
    databaseExists,
    pinnedInboxId,
    expectedInboxId: containerConfig.xmtpExpectedInboxId,
    allowNewInstallation: containerConfig.allowNewInstallation,
    databasePath: dbPath,
  });

  const client = await Client.create(signer, {
    env: containerConfig.xmtpEnv,
    dbPath,
    dbEncryptionKey: deriveDbEncryptionKey(privateKey),
    structuredLogging: true,
    // Critical: never let Client.create implicitly register. Existing state is
    // verified first; only the explicit one-time bootstrap branch may call register().
    disableAutoRegister: true,
  });

  const currentInboxId = client.inboxId.toLowerCase();
  if (currentInboxId !== deterministicInboxId) {
    throw new RecoveryRequiredError(
      `Client.inboxId ${currentInboxId} does not match wallet/network inbox ${deterministicInboxId}`,
    );
  }
  if (containerConfig.xmtpExpectedInboxId && currentInboxId !== containerConfig.xmtpExpectedInboxId) {
    throw new RecoveryRequiredError('Client.inboxId does not match XMTP_EXPECTED_INBOX_ID');
  }
  if (
    containerConfig.xmtpExpectedInstallationId &&
    client.installationId !== containerConfig.xmtpExpectedInstallationId
  ) {
    throw new RecoveryRequiredError(
      `Client.installationId ${client.installationId} does not match XMTP_EXPECTED_INSTALLATION_ID ${containerConfig.xmtpExpectedInstallationId}`,
    );
  }

  if (databaseExists) {
    if (!client.isRegistered) {
      throw new RecoveryRequiredError(
        'restored XMTP database does not contain a registered installation; refusing to register it',
      );
    }
  } else {
    if (!containerConfig.allowNewInstallation) {
      throw new RecoveryRequiredError('new XMTP installation registration is disabled');
    }
    await client.register();
    if (!client.isRegistered) throw new Error('Explicit XMTP bootstrap registration did not complete');
  }
  await writePinnedInboxId(containerConfig.dataDir, currentInboxId);
  return client;
}

function isGreetingMessage(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('```')) return false;
  if (trimmed === '?') return true;
  return /^(hello|hi|hey|help|start|info)(\b|[^a-z0-9])/i.test(trimmed);
}

function buildIntroMessage(): string {
  return [
    'Hello — I am the xmtp.mx relay bot.',
    '',
    'Outbound requests are checked against the relay allowlist.',
    'Send an email.send.v1 JSON message with to, optional cc/bcc/subject/replyTo, and text or html.',
  ].join('\n');
}

async function postEdgeEvent(event: EdgeXmtpEvent): Promise<boolean> {
  const persisted = await retryUntilSuccess({
    signal: edgeAbortController.signal,
    shouldStop: () => stopping,
    operation: async () => {
      const response = await fetch(`${config.edgeInternalUrl}/internal/v1/xmtp/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.containerSharedSecret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(event),
        signal: AbortSignal.any([edgeAbortController.signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) {
        const responseText = (await response.text()).slice(0, 4_096);
        throw new Error(`edge returned ${response.status}: ${responseText}`);
      }
    },
    onRetry: (error, attempt) => {
      const detail = error instanceof Error ? error.message : String(error);
      sendParent({ type: 'status', event: 'edge_event_retry', at: new Date().toISOString(), detail });
      log.warn({ error, messageId: event.messageId, attempt }, 'xmtp.edge_event_retry');
    },
  });
  if (persisted) {
    sendParent({ type: 'status', event: 'edge_event_delivered', at: new Date().toISOString() });
  }
  return persisted;
}

async function replyToConversation(conversation: Conversation<any>, content: string): Promise<string> {
  conversation.updateConsentState(ConsentState.Allowed);
  return conversation.send(content);
}

function markSourceMessageProcessed(message: DecodedMessage<any>, outcome: string): void {
  sendParent({
    type: 'status',
    event: 'source_message_processed',
    at: new Date().toISOString(),
    detail: message.sentAt.toISOString(),
  });
  log.debug({ messageId: message.id, outcome }, 'xmtp.source_message_processed');
}

async function handleXmtpMessage(message: DecodedMessage<any>, replay = false): Promise<void> {
  const client = xmtp;
  if (!client || stopping || seenMessageIds.checkAndAdd(message.id)) return;

  if (message.senderInboxId.toLowerCase() === client.inboxId.toLowerCase()) {
    markSourceMessageProcessed(message, 'self_sent');
    return;
  }
  if (typeof message.content !== 'string') {
    markSourceMessageProcessed(message, 'unsupported_content_type');
    return;
  }
  sendParent({ type: 'status', event: 'xmtp_message_received', at: new Date().toISOString() });

  const content = message.content.trim();
  if (!content) {
    markSourceMessageProcessed(message, 'empty');
    return;
  }

  const conversation = await client.conversations.getConversationById(message.conversationId);
  if (!conversation) {
    throw new Error(`XMTP conversation ${message.conversationId} is missing for message ${message.id}`);
  }
  if (Buffer.byteLength(content, 'utf8') > config.maxXmtpContentBytes) {
    if (replay) {
      markSourceMessageProcessed(message, 'oversized_replay_ignored');
      return;
    }
    await replyToConversation(
      conversation,
      JSON.stringify({
        type: 'email.send.result.v1',
        ok: false,
        mailgunId: null,
        error: 'payload_too_large',
      }),
    );
    markSourceMessageProcessed(message, 'oversized_rejected');
    return;
  }

  if (isGreetingMessage(content)) {
    if (replay) {
      markSourceMessageProcessed(message, 'greeting_replay_ignored');
      return;
    }
    await replyToConversation(conversation, buildIntroMessage());
    markSourceMessageProcessed(message, 'greeting_replied');
    return;
  }

  const canonicalContent = canonicalizeEmailSendEventContent(content);
  if (!canonicalContent) {
    if (!replay) await replyToConversation(conversation, buildIntroMessage());
    markSourceMessageProcessed(message, replay ? 'non_email_replay_ignored' : 'non_email_replied');
    return;
  }

  // Preserve the legacy JSON-ish acceptance behavior while handing the edge a
  // canonical JSON document. The Worker deliberately uses strict JSON.parse.
  if (Buffer.byteLength(canonicalContent, 'utf8') > config.maxXmtpContentBytes) {
    if (replay) {
      markSourceMessageProcessed(message, 'canonical_oversized_replay_ignored');
      return;
    }
    await replyToConversation(
      conversation,
      JSON.stringify({
        type: 'email.send.result.v1',
        ok: false,
        mailgunId: null,
        error: 'payload_too_large',
      }),
    );
    markSourceMessageProcessed(message, 'canonical_oversized_rejected');
    return;
  }

  const persisted = await postEdgeEvent({
    messageId: message.id,
    senderInboxId: message.senderInboxId.toLowerCase(),
    conversationId: message.conversationId,
    content: canonicalContent,
    receivedAt: message.sentAt.toISOString(),
  });
  if (persisted) {
    markSourceMessageProcessed(message, 'edge_persisted');
  }
}

async function catchUpMessages(client: Client<any>): Promise<void> {
  const cutoff = Date.parse(replayAfter);
  if (!Number.isFinite(cutoff)) throw new Error(`Invalid XMTP_REPLAY_AFTER_ISO: ${replayAfter}`);
  const conversations = await client.conversations.list({
    consentStates: [ConsentState.Allowed, ConsentState.Unknown],
  });
  const messages: DecodedMessage<any>[] = [];
  for (const conversation of conversations) {
    if (stopping) return;
    const recent = await conversation.messages({
      direction: SortDirection.Descending,
      limit: config.catchupMessagesPerConversation,
    });
    if (recent.length === config.catchupMessagesPerConversation) {
      const oldestReturned = recent.reduce(
        (oldest, message) => Math.min(oldest, message.sentAt.getTime()),
        Number.POSITIVE_INFINITY,
      );
      if (oldestReturned > cutoff) {
        throw new Error(
          `XMTP catch-up reached the configured limit (${config.catchupMessagesPerConversation}) before replayAfter; refusing to advance with a possible message gap`,
        );
      }
    }
    for (const message of recent) {
      if (message.sentAt.getTime() >= cutoff) messages.push(message);
    }
  }
  messages.sort((left, right) => left.sentAt.getTime() - right.sentAt.getTime());
  for (const message of messages) {
    if (stopping) return;
    await handleXmtpMessage(message, true);
  }
}

async function deliver(request: DeliveryRequest): Promise<string> {
  const client = xmtp;
  if (!client || !deanInboxId || stopping) throw new Error('xmtp_not_ready');
  const content = JSON.stringify(request.payload);
  if (Buffer.byteLength(content, 'utf8') > config.maxXmtpContentBytes) {
    throw new Error('xmtp_payload_too_large');
  }

  let conversation: Conversation<any> | undefined;
  if (request.conversationId) {
    conversation = await client.conversations.getConversationById(request.conversationId);
    if (!conversation) throw new Error('xmtp_conversation_not_found');
  } else {
    const targetInboxId = request.recipientInboxId ?? request.senderInboxId ?? deanInboxId;
    conversation = await client.conversations.newDm(targetInboxId);
  }
  const messageId = await replyToConversation(conversation, content);
  sendParent({
    type: 'status',
    event:
      request.kind === 'email.inbound.v1' ? 'inbound_email_delivered' : 'outbound_result_delivered',
    at: new Date().toISOString(),
  });
  return messageId;
}

function track<T>(operation: Promise<T>): Promise<T> {
  inFlight.add(operation);
  void operation.finally(() => inFlight.delete(operation));
  return operation;
}

async function shutdown(reason: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    stopping = true;
    log.info({ reason }, 'xmtp.child_shutdown');
    edgeAbortController.abort(new Error(`shutdown:${reason}`));
    try {
      await activeStream?.end();
    } catch (error) {
      log.warn({ error }, 'xmtp.stream_end_failed');
    }
    await Promise.allSettled([...inFlight]);
    process.disconnect?.();
    setImmediate(() => process.exit(0));
  })();
  return shutdownPromise;
}

process.on('message', (raw: ParentToChildMessage) => {
  if (!raw || typeof raw !== 'object') return;
  if (raw.type === 'shutdown') {
    void shutdown(raw.reason);
    return;
  }
  if (raw.type === 'deliver') {
    const operation = deliver(raw.request)
      .then((xmtpMessageId) => {
        sendParent({ type: 'delivery_result', requestId: raw.requestId, ok: true, xmtpMessageId });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        sendParent({ type: 'delivery_result', requestId: raw.requestId, ok: false, error: message });
      });
    void track(operation);
  }
});

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('disconnect', () => void shutdown('parent_disconnected'));

async function main(): Promise<void> {
  xmtp = await createStrictXmtpClient(config);
  log.info(
    { inboxId: xmtp.inboxId, installationId: xmtp.installationId },
    'xmtp.client_verified',
  );

  const provider = new ethers.providers.JsonRpcProvider(config.ethRpcUrl, { name: 'homestead', chainId: 1 });
  const deanAddress = await resolveXmtpAddress(config.xmtpDeanAddressOrEns, provider);
  deanInboxId = await xmtp.getInboxIdByIdentifier(makeEthereumIdentifier(deanAddress));
  if (!deanInboxId) throw new Error(`No XMTP inbox found for configured recipient ${deanAddress}`);

  await xmtp.conversations.syncAll([ConsentState.Allowed, ConsentState.Unknown]);
  activeStream = await xmtp.conversations.streamAllMessages(
    undefined,
    undefined,
    [ConsentState.Allowed, ConsentState.Unknown],
    () => sendParent({ type: 'status', event: 'xmtp_stream_failed', at: new Date().toISOString() }),
  );

  sendParent({ type: 'status', event: 'xmtp_stream_started', at: new Date().toISOString() });
  await catchUpMessages(xmtp);
  sendParent({
    type: 'ready',
    currentInboxId: xmtp.inboxId.toLowerCase(),
    pinnedInboxId: (await readPinnedInboxId(config.dataDir)) ?? '',
    installationId: xmtp.installationId,
    replayAfter,
  });

  for await (const message of activeStream) {
    if (stopping) break;
    if (!message) continue;
    // Do not advance past a failed source message. Exiting forces bounded child
    // restart and ordered catch-up from the last snapshotted overlap cutoff.
    await handleXmtpMessage(message);
  }

  if (!stopping) throw new Error('XMTP stream ended unexpectedly');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log.fatal({ error }, 'xmtp.child_fatal');
  sendParent({
    type: 'fatal',
    error: message,
    recoveryRequired: error instanceof RecoveryRequiredError,
  });
  setTimeout(() => process.exit(1), 25).unref();
});
