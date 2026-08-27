import type { RelayEnv } from './bindings';
import type {
  ContainerDeliveryRequest,
  EmailInboundV1,
  EmailSendResultV1,
  EmailSendV1,
  XmtpEvent,
} from './protocol';

export type InboundInsert = {
  dedupeKey: string;
  messageId: string | null;
  envelopeFrom: string;
  envelopeTo: string;
  headerFrom: string | null;
  headerTo: string | null;
  subject: string;
  text: string | null;
  html: string | null;
  threadId: string | null;
  receivedAt: string;
};

export type InboundRow = {
  id: number;
  dedupe_key: string;
  message_id: string | null;
  envelope_from: string;
  envelope_to: string;
  subject: string;
  text: string | null;
  html: string | null;
  status: string;
  attempt_count: number;
  last_error: string | null;
  received_at: string;
  xmtp_message_id: string | null;
  xmtp_delivered_at: string | null;
};

export type OutboundRow = {
  id: number;
  xmtp_msg_id: string;
  from_inbox: string;
  conversation_id: string;
  to_email: string | null;
  cc_email: string | null;
  bcc_email: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  reply_to: string | null;
  status: string;
  provider_message_id: string | null;
  error: string | null;
  attempt_count: number;
  result_delivered_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DeliveryJobRow = {
  job_id: string;
  kind: 'email.inbound.v1' | 'email.send.result.v1';
  record_key: string;
  conversation_id: string | null;
  recipient_inbox_id: string | null;
  sender_inbox_id: string | null;
  payload_json: string;
  status: string;
  attempt_count: number;
  last_error: string | null;
  queued_at: string | null;
  delivered_at: string | null;
  xmtp_message_id: string | null;
  created_at: string;
  updated_at: string;
};

export type SnapshotAnchorRow = {
  object_key: string;
  snapshot_id: string;
  created_at: string;
  created_at_ms: number;
  sha256: string;
  updated_at: string;
};

export async function seedConfiguredAllowlist(env: RelayEnv): Promise<void> {
  const values = (env.XMTP_ALLOWED_SENDERS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const invalid = values.find((value) => !/^[a-f0-9]{64}$/.test(value));
  if (invalid) {
    throw new Error(
      'XMTP_ALLOWED_SENDERS must contain verified 64-hex XMTP inbox IDs; ENS names and wallet addresses are not accepted at the edge',
    );
  }

  const now = new Date().toISOString();
  await env.RELAY_DB.batch([
    env.RELAY_DB.prepare("DELETE FROM allowlist_xmtp WHERE source = 'wrangler'"),
    ...values.map((value) => env.RELAY_DB.prepare(`
      INSERT OR IGNORE INTO allowlist_xmtp(sender_inbox_or_address, source, created_at)
      VALUES (?, 'wrangler', ?)
    `)
      .bind(value, now)),
  ]);
}

export async function isAllowlisted(env: RelayEnv, senderInboxId: string): Promise<boolean> {
  const row = await env.RELAY_DB
    .prepare('SELECT 1 AS allowed FROM allowlist_xmtp WHERE sender_inbox_or_address = ?')
    .bind(senderInboxId.trim().toLowerCase())
    .first<{ allowed: number }>();
  return row?.allowed === 1;
}

export async function resolveThreadId(
  env: RelayEnv,
  messageId: string | null,
  inReplyTo: string | null,
  fallback: string,
): Promise<string> {
  let threadId = messageId ?? fallback;
  if (inReplyTo) {
    const existing = await env.RELAY_DB
      .prepare('SELECT thread_id FROM thread_map WHERE message_id = ?')
      .bind(inReplyTo)
      .first<{ thread_id: string }>();
    if (existing?.thread_id) threadId = existing.thread_id;
  }

  if (messageId) {
    await env.RELAY_DB.prepare(`
      INSERT OR IGNORE INTO thread_map(message_id, thread_id, source, created_at)
      VALUES (?, ?, 'inbound_email', ?)
    `).bind(messageId, threadId, new Date().toISOString()).run();
  }
  return threadId;
}

export async function insertInboundEmail(
  env: RelayEnv,
  input: InboundInsert,
): Promise<{ row: InboundRow; inserted: boolean }> {
  const now = new Date().toISOString();
  const result = await env.RELAY_DB.prepare(`
    INSERT OR IGNORE INTO inbound_email(
      dedupe_key, message_id, envelope_from, envelope_to, header_from, header_to,
      subject, text, html, thread_id, status, received_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
  `).bind(
    input.dedupeKey,
    input.messageId,
    input.envelopeFrom,
    input.envelopeTo,
    input.headerFrom,
    input.headerTo,
    input.subject,
    input.text,
    input.html,
    input.threadId,
    input.receivedAt,
    now,
  ).run();

  const row = await env.RELAY_DB
    .prepare('SELECT * FROM inbound_email WHERE dedupe_key = ?')
    .bind(input.dedupeKey)
    .first<InboundRow>();
  if (!row) throw new Error('inbound_email insert could not be read back');
  return { row, inserted: (result.meta.changes ?? 0) > 0 };
}

export async function getInboundEmail(env: RelayEnv, id: number): Promise<InboundRow | null> {
  return env.RELAY_DB.prepare('SELECT * FROM inbound_email WHERE id = ?').bind(id).first<InboundRow>();
}

export async function createInboundDeliveryJob(
  env: RelayEnv,
  row: InboundRow,
): Promise<DeliveryJobRow> {
  const payload: EmailInboundV1 = {
    type: 'email.inbound.v1',
    to: row.envelope_to,
    from: row.envelope_from,
    subject: row.subject,
    text: row.text,
    html: row.html,
    messageId: row.message_id,
    receivedAt: row.received_at,
  };
  return createDeliveryJob(env, {
    jobId: `inbound:${row.id}`,
    kind: 'email.inbound.v1',
    recordKey: String(row.id),
    payload,
  });
}

export async function insertOutboundRequest(
  env: RelayEnv,
  event: XmtpEvent,
  request: EmailSendV1 | null,
  status: 'received' | 'denied' | 'invalid',
  error: string | null,
): Promise<{ row: OutboundRow; inserted: boolean }> {
  const now = new Date().toISOString();
  const result = await env.RELAY_DB.prepare(`
    INSERT OR IGNORE INTO outbound_request(
      xmtp_msg_id, from_inbox, conversation_id, to_email, cc_email, bcc_email,
      subject, text, html, reply_to, status, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.messageId,
    event.senderInboxId,
    event.conversationId,
    request ? JSON.stringify(request.to) : null,
    request ? JSON.stringify(request.cc) : null,
    request ? JSON.stringify(request.bcc) : null,
    request?.subject ?? null,
    request?.text ?? null,
    request?.html ?? null,
    request?.replyTo ?? null,
    status,
    error,
    now,
    now,
  ).run();

  const row = await getOutboundRequest(env, event.messageId);
  if (!row) throw new Error('outbound_request insert could not be read back');
  return { row, inserted: (result.meta.changes ?? 0) > 0 };
}

export async function getOutboundRequest(env: RelayEnv, xmtpMessageId: string): Promise<OutboundRow | null> {
  return env.RELAY_DB
    .prepare('SELECT * FROM outbound_request WHERE xmtp_msg_id = ?')
    .bind(xmtpMessageId)
    .first<OutboundRow>();
}

export async function createResultDeliveryJob(
  env: RelayEnv,
  row: OutboundRow,
  result: EmailSendResultV1,
): Promise<DeliveryJobRow> {
  return createDeliveryJob(env, {
    jobId: `result:${row.xmtp_msg_id}`,
    kind: 'email.send.result.v1',
    recordKey: row.xmtp_msg_id,
    conversationId: row.conversation_id,
    recipientInboxId: row.from_inbox,
    senderInboxId: row.from_inbox,
    payload: result,
  });
}

export async function createDeliveryJob(
  env: RelayEnv,
  input: {
    jobId: string;
    kind: ContainerDeliveryRequest['kind'];
    recordKey: string;
    conversationId?: string;
    recipientInboxId?: string;
    senderInboxId?: string;
    payload: EmailInboundV1 | EmailSendResultV1;
  },
): Promise<DeliveryJobRow> {
  const now = new Date().toISOString();
  await env.RELAY_DB.prepare(`
    INSERT OR IGNORE INTO delivery_job(
      job_id, kind, record_key, conversation_id, recipient_inbox_id,
      sender_inbox_id, payload_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
  `).bind(
    input.jobId,
    input.kind,
    input.recordKey,
    input.conversationId ?? null,
    input.recipientInboxId ?? null,
    input.senderInboxId ?? null,
    JSON.stringify(input.payload),
    now,
    now,
  ).run();

  const row = await getDeliveryJob(env, input.jobId);
  if (!row) throw new Error('delivery_job insert could not be read back');
  return row;
}

export async function getDeliveryJob(env: RelayEnv, jobId: string): Promise<DeliveryJobRow | null> {
  return env.RELAY_DB.prepare('SELECT * FROM delivery_job WHERE job_id = ?').bind(jobId).first<DeliveryJobRow>();
}

export async function markDeliveryQueued(env: RelayEnv, jobId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.RELAY_DB.prepare(`
    UPDATE delivery_job
    SET status = CASE WHEN status = 'received' THEN 'queued' ELSE status END,
        queued_at = ?, updated_at = ?
    WHERE job_id = ? AND status = 'received'
  `).bind(now, now, jobId).run();
}

export async function claimDeliveryJob(env: RelayEnv, jobId: string): Promise<boolean> {
  const result = await env.RELAY_DB.prepare(`
    UPDATE delivery_job
    SET status = 'delivering', attempt_count = attempt_count + 1, last_error = NULL, updated_at = ?
    WHERE job_id = ? AND status IN ('received', 'queued', 'retrying')
  `).bind(new Date().toISOString(), jobId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markDeliveryRetry(env: RelayEnv, jobId: string, error: string): Promise<void> {
  const now = new Date().toISOString();
  await env.RELAY_DB.batch([env.RELAY_DB.prepare(`
    UPDATE delivery_job SET status = 'retrying', last_error = ?, updated_at = ?
    WHERE job_id = ? AND status = 'delivering'
  `).bind(error, now, jobId), env.RELAY_DB.prepare(`
    UPDATE inbound_email
    SET status = 'retrying',
        attempt_count = COALESCE((SELECT attempt_count FROM delivery_job WHERE job_id = ?), attempt_count),
        last_error = ?, updated_at = ?
    WHERE id = (SELECT CAST(record_key AS INTEGER) FROM delivery_job
                WHERE job_id = ? AND kind = 'email.inbound.v1' AND status = 'retrying')
  `).bind(jobId, error, now, jobId)]);
}

export async function markDeliveryUncertain(env: RelayEnv, jobId: string, error: string): Promise<void> {
  const now = new Date().toISOString();
  await env.RELAY_DB.batch([env.RELAY_DB.prepare(`
    UPDATE delivery_job SET status = 'uncertain', last_error = ?, updated_at = ?
    WHERE job_id = ? AND status = 'delivering'
  `).bind(error, now, jobId), env.RELAY_DB.prepare(`
    UPDATE inbound_email
    SET status = 'uncertain',
        attempt_count = COALESCE((SELECT attempt_count FROM delivery_job WHERE job_id = ?), attempt_count),
        last_error = ?, updated_at = ?
    WHERE id = (SELECT CAST(record_key AS INTEGER) FROM delivery_job
                WHERE job_id = ? AND kind = 'email.inbound.v1' AND status = 'uncertain')
  `).bind(jobId, error, now, jobId)]);
}

export async function markDeliveryFailed(
  env: RelayEnv,
  jobId: string,
  error: string,
  expectedStatus = 'delivering',
): Promise<DeliveryJobRow> {
  const now = new Date().toISOString();
  await env.RELAY_DB.batch([env.RELAY_DB.prepare(`
    UPDATE delivery_job SET status = 'failed', last_error = ?, updated_at = ?
    WHERE job_id = ? AND status = ?
  `).bind(error, now, jobId, expectedStatus), env.RELAY_DB.prepare(`
    UPDATE inbound_email
    SET status = 'failed',
        attempt_count = COALESCE((SELECT attempt_count FROM delivery_job WHERE job_id = ?), attempt_count),
        last_error = ?, updated_at = ?
    WHERE id = (SELECT CAST(record_key AS INTEGER) FROM delivery_job
                WHERE job_id = ? AND kind = 'email.inbound.v1' AND status = 'failed')
  `).bind(jobId, error, now, jobId)]);
  const row = await getDeliveryJob(env, jobId);
  if (!row) throw new Error('delivery job disappeared after failed transition');
  return row;
}

export async function markDeliveryComplete(
  env: RelayEnv,
  row: DeliveryJobRow,
  xmtpMessageId: string | null,
): Promise<DeliveryJobRow> {
  const now = new Date().toISOString();
  const statements = [env.RELAY_DB.prepare(`
    UPDATE delivery_job
    SET status = 'delivered', delivered_at = ?, xmtp_message_id = ?, last_error = NULL, updated_at = ?
    WHERE job_id = ? AND status IN ('delivering', 'uncertain')
  `).bind(now, xmtpMessageId, now, row.job_id)];

  if (row.kind === 'email.inbound.v1') {
    statements.push(env.RELAY_DB.prepare(`
      UPDATE inbound_email
      SET status = 'delivered', xmtp_delivered_at = ?, xmtp_message_id = ?,
          attempt_count = COALESCE((SELECT attempt_count FROM delivery_job WHERE job_id = ?), attempt_count),
          last_error = NULL, updated_at = ?
      WHERE id = ? AND EXISTS (
        SELECT 1 FROM delivery_job WHERE job_id = ? AND status = 'delivered'
      )
    `).bind(now, xmtpMessageId, row.job_id, now, Number(row.record_key), row.job_id));
  } else {
    statements.push(env.RELAY_DB.prepare(`
      UPDATE outbound_request SET result_delivered_at = ?, updated_at = ?
      WHERE xmtp_msg_id = ? AND EXISTS (
        SELECT 1 FROM delivery_job WHERE job_id = ? AND status = 'delivered'
      )
    `).bind(now, now, row.record_key, row.job_id));
  }
  await env.RELAY_DB.batch(statements);
  const completed = await getDeliveryJob(env, row.job_id);
  if (!completed) throw new Error('delivery job disappeared after completed transition');
  return completed;
}

export async function markOutboundQueued(env: RelayEnv, xmtpMessageId: string): Promise<void> {
  await env.RELAY_DB.prepare(`
    UPDATE outbound_request
    SET status = CASE WHEN status = 'received' THEN 'queued' ELSE status END,
        updated_at = ?
    WHERE xmtp_msg_id = ? AND status = 'received'
  `).bind(new Date().toISOString(), xmtpMessageId).run();
}

export async function claimOutboundRequest(env: RelayEnv, xmtpMessageId: string): Promise<boolean> {
  const result = await env.RELAY_DB.prepare(`
    UPDATE outbound_request
    SET status = 'sending', attempt_count = attempt_count + 1, error = NULL, updated_at = ?
    WHERE xmtp_msg_id = ? AND status IN ('received', 'queued', 'retrying')
  `).bind(new Date().toISOString(), xmtpMessageId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markOutboundRetry(env: RelayEnv, xmtpMessageId: string, error: string): Promise<void> {
  await env.RELAY_DB.prepare(`
    UPDATE outbound_request SET status = 'retrying', error = ?, updated_at = ?
    WHERE xmtp_msg_id = ? AND status = 'sending'
  `).bind(error, new Date().toISOString(), xmtpMessageId).run();
}

export async function markOutboundSent(
  env: RelayEnv,
  xmtpMessageId: string,
  providerMessageId: string,
): Promise<OutboundRow> {
  await env.RELAY_DB.prepare(`
    UPDATE outbound_request
    SET status = 'sent', provider_message_id = ?, error = NULL, updated_at = ?
    WHERE xmtp_msg_id = ? AND status IN ('sending', 'uncertain')
  `).bind(providerMessageId, new Date().toISOString(), xmtpMessageId).run();
  const row = await getOutboundRequest(env, xmtpMessageId);
  if (!row) throw new Error('outbound request disappeared after send');
  return row;
}

export async function markOutboundFailed(
  env: RelayEnv,
  xmtpMessageId: string,
  status: 'failed' | 'uncertain',
  error: string,
  expectedStatus = 'sending',
): Promise<OutboundRow> {
  await env.RELAY_DB.prepare(`
    UPDATE outbound_request SET status = ?, error = ?, updated_at = ?
    WHERE xmtp_msg_id = ? AND status = ?
  `).bind(status, error, new Date().toISOString(), xmtpMessageId, expectedStatus).run();
  const row = await getOutboundRequest(env, xmtpMessageId);
  if (!row) throw new Error('outbound request disappeared after failure');
  return row;
}

export async function recordQueueFailure(
  env: RelayEnv,
  queueName: string,
  jobId: string,
  attempts: number,
  error: string,
): Promise<void> {
  await env.RELAY_DB.prepare(`
    INSERT INTO queue_failure(queue_name, job_id, attempts, error, failed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(queue_name, job_id) DO UPDATE SET
      attempts = MAX(queue_failure.attempts, excluded.attempts),
      error = excluded.error,
      failed_at = excluded.failed_at
  `).bind(queueName, jobId, attempts, error, new Date().toISOString()).run();
}

export async function setRelayState(env: RelayEnv, key: string, value: unknown): Promise<void> {
  const now = new Date().toISOString();
  await env.RELAY_DB.prepare(`
    INSERT INTO relay_state(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(key, JSON.stringify(value), now).run();
}

export async function getRelayState<T>(env: RelayEnv, key: string): Promise<T | null> {
  const row = await env.RELAY_DB
    .prepare('SELECT value FROM relay_state WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function getSnapshotAnchor(
  env: RelayEnv,
  objectKey: string,
): Promise<SnapshotAnchorRow | null> {
  return env.RELAY_DB.prepare('SELECT * FROM snapshot_anchor WHERE object_key = ?')
    .bind(objectKey)
    .first<SnapshotAnchorRow>();
}

export async function reserveSnapshotAnchor(
  env: RelayEnv,
  input: {
    objectKey: string;
    snapshotId: string;
    createdAt: string;
    createdAtMs: number;
    sha256: string;
  },
): Promise<boolean> {
  const now = new Date().toISOString();
  await env.RELAY_DB.prepare(`
    INSERT INTO snapshot_anchor(
      object_key, snapshot_id, created_at, created_at_ms, sha256, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(object_key) DO UPDATE SET
      snapshot_id = excluded.snapshot_id,
      created_at = excluded.created_at,
      created_at_ms = excluded.created_at_ms,
      sha256 = excluded.sha256,
      updated_at = excluded.updated_at
    WHERE (
      snapshot_anchor.snapshot_id = excluded.snapshot_id
      AND snapshot_anchor.sha256 = excluded.sha256
    ) OR excluded.created_at_ms > snapshot_anchor.created_at_ms
  `).bind(
    input.objectKey,
    input.snapshotId,
    input.createdAt,
    input.createdAtMs,
    input.sha256,
    now,
  ).run();
  const anchored = await getSnapshotAnchor(env, input.objectKey);
  return Boolean(
    anchored
    && anchored.snapshot_id === input.snapshotId
    && anchored.created_at === input.createdAt
    && anchored.sha256 === input.sha256,
  );
}

export async function getStatusSnapshot(env: RelayEnv): Promise<Record<string, unknown>> {
  const [
    inboundCounts,
    outboundCounts,
    deliveryCounts,
    failureCount,
    state,
    inboundRecent,
    outboundRecent,
    snapshotAnchor,
    oldestPending,
    recentQueueFailures,
  ] =
    await Promise.all([
      env.RELAY_DB.prepare('SELECT status, COUNT(*) AS count FROM inbound_email GROUP BY status').all(),
      env.RELAY_DB.prepare('SELECT status, COUNT(*) AS count FROM outbound_request GROUP BY status').all(),
      env.RELAY_DB.prepare('SELECT status, COUNT(*) AS count FROM delivery_job GROUP BY status').all(),
      env.RELAY_DB.prepare('SELECT COUNT(*) AS count FROM queue_failure').first<{ count: number }>(),
      env.RELAY_DB.prepare('SELECT key, value, updated_at FROM relay_state ORDER BY key').all(),
      env.RELAY_DB.prepare(`
        SELECT id, dedupe_key, message_id, status, attempt_count, last_error,
               xmtp_message_id, received_at, xmtp_delivered_at
        FROM inbound_email ORDER BY id DESC LIMIT 20
      `).all(),
      env.RELAY_DB.prepare(`
        SELECT xmtp_msg_id, from_inbox, status, provider_message_id, attempt_count,
               error, created_at, updated_at, result_delivered_at
        FROM outbound_request ORDER BY id DESC LIMIT 20
      `).all(),
      env.RELAY_DB.prepare(`
        SELECT object_key, snapshot_id, created_at, sha256, updated_at
        FROM snapshot_anchor ORDER BY updated_at DESC LIMIT 1
      `).first(),
      env.RELAY_DB.prepare(`
        SELECT 'inbound_email' AS source, MIN(updated_at) AS oldest_updated_at
        FROM inbound_email WHERE status IN ('received', 'queued', 'retrying')
        UNION ALL
        SELECT 'outbound_request' AS source, MIN(updated_at) AS oldest_updated_at
        FROM outbound_request WHERE status IN ('received', 'queued', 'retrying', 'sending')
        UNION ALL
        SELECT 'xmtp_delivery' AS source, MIN(updated_at) AS oldest_updated_at
        FROM delivery_job WHERE status IN ('received', 'queued', 'retrying', 'delivering')
      `).all<{ source: string; oldest_updated_at: string | null }>(),
      env.RELAY_DB.prepare(`
        SELECT queue_name, job_id, attempts, error, failed_at
        FROM queue_failure ORDER BY id DESC LIMIT 20
      `).all(),
    ]);

  return {
    inbound: { counts: rowsToCounts(inboundCounts.results), recent: inboundRecent.results },
    outbound: { counts: rowsToCounts(outboundCounts.results), recent: outboundRecent.results },
    xmtpDelivery: { counts: rowsToCounts(deliveryCounts.results) },
    deadLettered: failureCount?.count ?? 0,
    oldestPending: Object.fromEntries(oldestPending.results.map((row) => [
      row.source,
      pendingAge(row.oldest_updated_at),
    ])),
    recentQueueFailures: recentQueueFailures.results,
    snapshotAnchor,
    relayState: state.results,
  };
}

export async function listRecoverableWork(
  env: RelayEnv,
  staleBefore = new Date().toISOString(),
): Promise<{
  inboundIds: number[];
  outboundIds: string[];
  outboundResultIds: string[];
  deliveryJobIds: string[];
}> {
  const [inbound, outbound, outboundResult, delivery] = await Promise.all([
    env.RELAY_DB.prepare(`
      SELECT id FROM inbound_email
      WHERE status = 'received' AND xmtp_delivered_at IS NULL AND updated_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM delivery_job WHERE job_id = 'inbound:' || inbound_email.id
        )
      ORDER BY id LIMIT 100
    `).bind(staleBefore).all<{ id: number }>(),
    env.RELAY_DB.prepare(`
      SELECT xmtp_msg_id FROM outbound_request
      WHERE status = 'received' AND updated_at <= ?
      ORDER BY id LIMIT 100
    `).bind(staleBefore).all<{ xmtp_msg_id: string }>(),
    env.RELAY_DB.prepare(`
      SELECT xmtp_msg_id FROM outbound_request
      WHERE status IN ('sent', 'failed', 'uncertain', 'denied', 'invalid')
        AND result_delivered_at IS NULL AND updated_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM delivery_job WHERE job_id = 'result:' || outbound_request.xmtp_msg_id
        )
      ORDER BY id LIMIT 100
    `).bind(staleBefore).all<{ xmtp_msg_id: string }>(),
    env.RELAY_DB.prepare(`
      SELECT job_id FROM delivery_job
      WHERE status = 'received' AND updated_at <= ?
      ORDER BY created_at LIMIT 100
    `).bind(staleBefore).all<{ job_id: string }>(),
  ]);
  return {
    inboundIds: inbound.results.map((row) => row.id),
    outboundIds: outbound.results.map((row) => row.xmtp_msg_id),
    outboundResultIds: outboundResult.results.map((row) => row.xmtp_msg_id),
    deliveryJobIds: delivery.results.map((row) => row.job_id),
  };
}

export async function listAbandonedInflight(
  env: RelayEnv,
  staleBefore: string,
): Promise<{ outboundIds: string[]; deliveryJobIds: string[] }> {
  const [outbound, delivery] = await Promise.all([
    env.RELAY_DB.prepare(`
      SELECT xmtp_msg_id FROM outbound_request
      WHERE status = 'sending' AND updated_at <= ?
      ORDER BY id LIMIT 100
    `).bind(staleBefore).all<{ xmtp_msg_id: string }>(),
    env.RELAY_DB.prepare(`
      SELECT job_id FROM delivery_job
      WHERE status = 'delivering' AND updated_at <= ?
      ORDER BY created_at LIMIT 100
    `).bind(staleBefore).all<{ job_id: string }>(),
  ]);
  return {
    outboundIds: outbound.results.map((row) => row.xmtp_msg_id),
    deliveryJobIds: delivery.results.map((row) => row.job_id),
  };
}

export type OrphanedBrokerWork = {
  outbound: Array<{ xmtpMessageId: string; status: 'queued' | 'retrying' }>;
  delivery: Array<{ jobId: string; status: 'queued' | 'retrying' }>;
};

export async function listOrphanedBrokerWork(
  env: RelayEnv,
  staleBefore: string,
): Promise<OrphanedBrokerWork> {
  const [outbound, delivery] = await Promise.all([
    env.RELAY_DB.prepare(`
      SELECT xmtp_msg_id, status FROM outbound_request
      WHERE status IN ('queued', 'retrying') AND updated_at <= ?
      ORDER BY id LIMIT 100
    `).bind(staleBefore).all<{ xmtp_msg_id: string; status: 'queued' | 'retrying' }>(),
    env.RELAY_DB.prepare(`
      SELECT job_id, status FROM delivery_job
      WHERE status IN ('queued', 'retrying') AND updated_at <= ?
      ORDER BY created_at LIMIT 100
    `).bind(staleBefore).all<{ job_id: string; status: 'queued' | 'retrying' }>(),
  ]);
  return {
    outbound: outbound.results.map((row) => ({
      xmtpMessageId: row.xmtp_msg_id,
      status: row.status,
    })),
    delivery: delivery.results.map((row) => ({
      jobId: row.job_id,
      status: row.status,
    })),
  };
}

export async function refreshOutboundBrokerHandoff(
  env: RelayEnv,
  xmtpMessageId: string,
  expectedStatus: 'queued' | 'retrying',
): Promise<void> {
  await env.RELAY_DB.prepare(`
    UPDATE outbound_request SET updated_at = ?
    WHERE xmtp_msg_id = ? AND status = ?
  `).bind(new Date().toISOString(), xmtpMessageId, expectedStatus).run();
}

export async function refreshDeliveryBrokerHandoff(
  env: RelayEnv,
  jobId: string,
  expectedStatus: 'queued' | 'retrying',
): Promise<void> {
  const now = new Date().toISOString();
  await env.RELAY_DB.batch([env.RELAY_DB.prepare(`
    UPDATE delivery_job SET queued_at = ?, updated_at = ?
    WHERE job_id = ? AND status = ?
  `).bind(now, now, jobId, expectedStatus), env.RELAY_DB.prepare(`
    UPDATE inbound_email SET updated_at = ?
    WHERE id = (SELECT CAST(record_key AS INTEGER) FROM delivery_job
                WHERE job_id = ? AND kind = 'email.inbound.v1' AND status = ?)
  `).bind(now, jobId, expectedStatus)]);
}

function rowsToCounts(rows: Record<string, unknown>[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count)]));
}

function pendingAge(updatedAt: string | null): { updatedAt: string; ageSeconds: number } | null {
  if (!updatedAt) return null;
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return { updatedAt, ageSeconds: -1 };
  return {
    updatedAt,
    ageSeconds: Math.max(0, Math.floor((Date.now() - timestamp) / 1_000)),
  };
}
