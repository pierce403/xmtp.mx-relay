#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import {
  assertHealth,
  buildEmailSendV1,
  buildInboundEmail,
  d1Query,
  dispatchLocalEmail,
  fetchJson,
  makeCorrelationId,
  normalizeBaseUrl,
  parseEmailSendResult,
  parsePositiveInteger,
  requireValue,
  sendSmtp,
  verifyEmailDns,
  waitFor,
} from './cloudflare-smoke-lib.mjs';

dotenv.config();

const PRODUCTION_CONTAINER_NAME = 'xmtp-mx-relay-production';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const SUITES = new Set(['safe', 'local', 'production', 'recovery', 'all']);

export function parseCliArgs(argv) {
  const parsed = { suite: 'safe', confirm: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--suite') parsed.suite = argv[++index];
    else if (arg === '--confirm') parsed.confirm = argv[++index];
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!SUITES.has(parsed.suite)) {
    throw new Error(`--suite must be one of: ${[...SUITES].join(', ')}`);
  }
  return parsed;
}

export function loadSmokeConfig(env = process.env) {
  const edgeUrl = normalizeBaseUrl(
    requireValue(env.SMOKE_EDGE_URL?.trim(), 'SMOKE_EDGE_URL'),
    'SMOKE_EDGE_URL',
  );
  return {
    edgeUrl,
    frontendUrl: normalizeBaseUrl(env.SMOKE_FRONTEND_URL || 'https://xmtp.mx', 'SMOKE_FRONTEND_URL'),
    internalSecret: env.SMOKE_INTERNAL_SECRET?.trim() || '',
    adminToken: env.SMOKE_ADMIN_TOKEN?.trim() || '',
    expectedContainerName: env.SMOKE_CONTAINER_NAME?.trim() || PRODUCTION_CONTAINER_NAME,
    domain: env.SMOKE_DOMAIN?.trim() || 'xmtp.mx',
    inboundTo: env.SMOKE_INBOUND_TO?.trim() || 'deanpierce.eth@xmtp.mx',
    inboundFrom: env.SMOKE_INBOUND_FROM?.trim() || '',
    inboundMode: env.SMOKE_INBOUND_MODE?.trim() || (env.SMOKE_SMTP_URL ? 'smtp' : 'local'),
    smtpUrl: env.SMOKE_SMTP_URL?.trim() || '',
    smtpInsecureTls: isTruthy(env.SMOKE_SMTP_INSECURE_TLS),
    xmtpEnv: normalizeXmtpEnv(env.SMOKE_XMTP_ENV || env.XMTP_ENV),
    xmtpBotAddress: env.SMOKE_XMTP_BOT_ADDRESS?.trim() || env.XMTP_BOT_ADDRESS_OR_ENS?.trim() || '',
    xmtpSenderKey: env.SMOKE_XMTP_SENDER_KEY?.trim() || env.XMTP_TEST_SENDER_KEY?.trim() || '',
    xmtpSenderDb: path.resolve(
      env.SMOKE_XMTP_SENDER_DB?.trim() || path.join(repoRoot, '.smoke-data', 'allowlisted-sender.db3'),
    ),
    xmtpAllowNewSenderInstallation: isTruthy(env.SMOKE_XMTP_ALLOW_NEW_SENDER_INSTALLATION),
    unauthorizedXmtpKey: env.SMOKE_UNAUTHORIZED_XMTP_KEY?.trim() || '',
    unauthorizedXmtpDb: path.resolve(
      env.SMOKE_UNAUTHORIZED_XMTP_DB?.trim() || path.join(repoRoot, '.smoke-data', 'unauthorized-sender.db3'),
    ),
    xmtpAllowNewUnauthorizedInstallation: isTruthy(env.SMOKE_XMTP_ALLOW_NEW_UNAUTHORIZED_INSTALLATION),
    emailRecipients: splitCsv(env.SMOKE_EMAIL_RECIPIENTS || env.TEST_EMAIL_RECIPIENT),
    ccRecipients: splitCsv(env.SMOKE_EMAIL_CC),
    bccRecipients: splitCsv(env.SMOKE_EMAIL_BCC),
    replyTo: env.SMOKE_EMAIL_REPLY_TO?.trim() || null,
    ethRpcUrl: env.ETH_RPC_URL?.trim() || 'https://ethereum.publicnode.com',
    waitTimeoutMs: parsePositiveInteger(env.SMOKE_WAIT_TIMEOUT_MS, 'SMOKE_WAIT_TIMEOUT_MS', 180_000),
    pollIntervalMs: parsePositiveInteger(env.SMOKE_POLL_INTERVAL_MS, 'SMOKE_POLL_INTERVAL_MS', 2_000),
    d1: {
      accountId: env.CLOUDFLARE_ACCOUNT_ID?.trim() || '',
      databaseId: env.SMOKE_D1_DATABASE_ID?.trim() || env.CLOUDFLARE_D1_DATABASE_ID?.trim() || '',
      apiToken: env.CLOUDFLARE_API_TOKEN?.trim() || '',
    },
    sendingDkimName: env.SMOKE_SENDING_DKIM_NAME?.trim() || undefined,
    routingDkimName: env.SMOKE_ROUTING_DKIM_NAME?.trim() || undefined,
    restartPath: env.SMOKE_CONTAINER_RESTART_PATH?.trim() || '/internal/v1/container/restart',
    recreatePath: env.SMOKE_CONTAINER_RECREATE_PATH?.trim() || '/internal/v1/container/recreate',
  };
}

export async function runSuite(args, config = loadSmokeConfig()) {
  const results = [];
  const run = async (id, name, action) => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    try {
      const details = await action();
      results.push({ id, name, ok: true, durationMs: Date.now() - started, startedAt, details });
      if (!args.json) console.log(`PASS ${id}: ${name}`);
      return details;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ id, name, ok: false, durationMs: Date.now() - started, startedAt, error: message });
      if (!args.json) console.error(`FAIL ${id}: ${name}: ${message}`);
      throw error;
    }
  };

  if (['local', 'production', 'all'].includes(args.suite)) {
    requireValue(config.internalSecret, 'SMOKE_INTERNAL_SECRET');
  }
  if (['local', 'production', 'recovery', 'all'].includes(args.suite)) {
    requireValue(config.adminToken, 'SMOKE_ADMIN_TOKEN');
  }

  await run('OBS', config.adminToken
    ? 'edge health and private endpoint authentication'
    : 'public edge health', async () => {
    if (config.adminToken) {
      return assertHealth({
        edgeUrl: config.edgeUrl,
        adminToken: config.adminToken,
        expectedContainerName: config.expectedContainerName,
      });
    }
    const { response, body } = await fetchJson(`${config.edgeUrl}/healthz`);
    assert.equal(response.status, 200, 'GET /healthz must return 200');
    assert.equal(body?.ok, true, 'GET /healthz must report ok=true');
    return body;
  });

  if (['safe', 'production', 'all'].includes(args.suite)) {
    await run('I', 'production frontend', () => checkFrontend(config.frontendUrl));
    await run('J', 'Cloudflare MX, SPF, DKIM, and DMARC', () =>
      verifyEmailDns(config.domain, {
        sendingDkimName: config.sendingDkimName,
        routingDkimName: config.routingDkimName,
      }),
    );
  }

  if (['local', 'production', 'all'].includes(args.suite)) {
    requireD1(config.d1);
    const inbound = await run('A/D', 'email dedupe -> durable job -> one recorded XMTP delivery', () =>
      testInbound(config),
    );
    const outbound = await run('B', 'allowlisted XMTP -> Cloudflare Email Service -> result', () =>
      testOutbound(config, { authorized: true }),
    );
    await run('C', 'unauthorized XMTP sender is denied', () =>
      testOutbound(config, { authorized: false }),
    );
    await run('E', 'replayed XMTP event does not resend email', () =>
      testReplay(config, outbound),
    );
    if (!args.json) {
      console.log(`INFO correlation IDs: inbound=${inbound.correlationId} outbound=${outbound.correlationId}`);
    }
  }

  if (['recovery', 'all'].includes(args.suite)) {
    requireRecoveryConfirmation(args, config);
    await run('F', 'Container restart preserves inbox and installation', () =>
      testContainerLifecycle(config, { path: config.restartPath, requireR2Restore: false }),
    );
    await run('G', 'fresh Container filesystem restores XMTP state from R2', () =>
      testContainerLifecycle(config, { path: config.recreatePath, requireR2Restore: true }),
    );
  }

  if (args.json) console.log(JSON.stringify({ ok: results.every((result) => result.ok), results }, null, 2));
  return results;
}

async function checkFrontend(frontendUrl) {
  const response = await fetch(frontendUrl, { redirect: 'follow' });
  assert.equal(response.status, 200, `frontend must return 200, got ${response.status}`);
  const finalUrl = new URL(response.url);
  assert.equal(finalUrl.hostname, new URL(frontendUrl).hostname, 'frontend must stay on the production hostname');
  const html = await response.text();
  assert.match(html, /<html[\s>]/i, 'frontend response must contain HTML');
  return { url: response.url, contentLength: html.length };
}

async function testInbound(config) {
  requireValue(config.inboundFrom, 'SMOKE_INBOUND_FROM');
  const correlationId = makeCorrelationId('inbound');
  const email = buildInboundEmail({ correlationId, from: config.inboundFrom, to: config.inboundTo });
  const deliver = async () => {
    if (config.inboundMode === 'local') {
      return dispatchLocalEmail({
        edgeUrl: config.edgeUrl,
        from: config.inboundFrom,
        to: config.inboundTo,
        raw: email.raw,
      });
    }
    if (config.inboundMode === 'smtp') {
      return sendSmtp({
        smtpUrl: requireValue(config.smtpUrl, 'SMOKE_SMTP_URL'),
        from: config.inboundFrom,
        to: config.inboundTo,
        raw: email.raw,
        insecureTls: config.smtpInsecureTls,
      });
    }
    throw new Error('SMOKE_INBOUND_MODE must be local or smtp');
  };

  await deliver();
  await deliver();
  const records = await waitForD1Records(config, {
    table: 'inbound_email',
    candidates: ['message_id', 'dedupe_key', 'provider_message_id'],
    values: [email.messageId, email.messageId.slice(1, -1)],
    predicate: (rows) => rows.length === 1 && rows.some(isDelivered),
    label: `inbound email ${email.messageId} to be delivered`,
  });
  assert.equal(records.length, 1, 'duplicate inbound delivery must create exactly one D1 row');
  await assertSingleInboundDeliveryJob(config, records[0]);
  return { correlationId, messageId: email.messageId, record: scrubRecord(records[0]) };
}

async function testOutbound(config, { authorized }) {
  const key = authorized
    ? requireValue(config.xmtpSenderKey, 'SMOKE_XMTP_SENDER_KEY')
    : requireValue(config.unauthorizedXmtpKey, 'SMOKE_UNAUTHORIZED_XMTP_KEY');
  const dbPath = authorized ? config.xmtpSenderDb : config.unauthorizedXmtpDb;
  const allowNew = authorized
    ? config.xmtpAllowNewSenderInstallation
    : config.xmtpAllowNewUnauthorizedInstallation;
  if (config.xmtpEnv === 'production' && !fs.existsSync(dbPath) && !allowNew) {
    throw new Error(
      `${dbPath} does not exist. Refusing to create a production smoke-test XMTP installation; ` +
      `set ${authorized ? 'SMOKE_XMTP_ALLOW_NEW_SENDER_INSTALLATION' : 'SMOKE_XMTP_ALLOW_NEW_UNAUTHORIZED_INSTALLATION'}=true for the one-time bootstrap only.`,
    );
  }

  if (authorized && config.emailRecipients.length === 0) {
    throw new Error('SMOKE_EMAIL_RECIPIENTS (or TEST_EMAIL_RECIPIENT) must contain a real test inbox');
  }
  const correlationId = makeCorrelationId(authorized ? 'outbound' : 'unauthorized');
  const payload = buildEmailSendV1({
    correlationId,
    to: authorized ? config.emailRecipients : ['must-not-send@example.invalid'],
    cc: authorized ? config.ccRecipients : [],
    bcc: authorized ? config.bccRecipients : [],
    replyTo: authorized ? config.replyTo : null,
  });
  const client = await createSmokeXmtpClient({
    key,
    dbPath,
    env: config.xmtpEnv,
    allowNewInstallation: allowNew,
  });
  try {
    let outboundRecord = null;
    const botAddress = await resolveAddress(config.xmtpBotAddress, config.ethRpcUrl);
    const { IdentifierKind, ConsentState, getInboxIdForIdentifier } = await import('@xmtp/node-sdk');
    const botInboxId = await getInboxIdForIdentifier(
      { identifier: botAddress, identifierKind: IdentifierKind.Ethereum },
      config.xmtpEnv,
    );
    if (!botInboxId) throw new Error(`No XMTP inbox exists for relay ${botAddress}`);
    const conversation = await client.conversations.newDm(botInboxId);
    conversation.updateConsentState(ConsentState.Allowed);
    const startedAt = Date.now();
    const xmtpMessageId = await conversation.send(JSON.stringify(payload));
    const result = await waitFor(
      async () => {
        await conversation.sync();
        const messages = await conversation.messages({ limit: 100, direction: 1 });
        for (const message of messages) {
          if (message.senderInboxId.toLowerCase() !== botInboxId.toLowerCase()) continue;
          if (message.sentAt.getTime() < startedAt - 5_000) continue;
          const parsed = parseEmailSendResult(message.content);
          if (parsed) return { message, parsed };
        }
        return null;
      },
      {
        timeoutMs: config.waitTimeoutMs,
        intervalMs: config.pollIntervalMs,
        label: `email.send.result.v1 for ${xmtpMessageId}`,
      },
    );
    assert.equal(result.parsed.ok, authorized, authorized ? 'allowlisted send must succeed' : 'unauthorized send must fail');
    if (!authorized) {
      assert.match(String(result.parsed.error), /allowlist|authorized|denied/i, 'denial must identify authorization failure');
      const deniedRows = await findD1Records(config, {
        table: 'outbound_request',
        candidates: ['xmtp_message_id', 'xmtp_msg_id'],
        values: [xmtpMessageId],
      });
      assert.ok(deniedRows.length === 0 || deniedRows.every((row) => !isDelivered(row)), 'unauthorized event must not be delivered');
    } else {
      const rows = await waitForD1Records(config, {
        table: 'outbound_request',
        candidates: ['xmtp_message_id', 'xmtp_msg_id'],
        values: [xmtpMessageId],
        predicate: (items) => items.length === 1 && items.some(isDelivered),
        label: `outbound request ${xmtpMessageId} to be delivered`,
      });
      assert.equal(rows.length, 1, 'outbound XMTP message must map to exactly one D1 request');
      outboundRecord = scrubRecord(rows[0]);
    }
    return {
      correlationId,
      xmtpMessageId,
      senderInboxId: client.inboxId,
      conversationId: conversation.id,
      payload,
      result: result.parsed,
      record: outboundRecord,
    };
  } finally {
    // @xmtp/node-sdk 3.2.2 does not expose Client.close(). Keep this
    // forward-compatible if a later SDK adds one; otherwise process exit owns
    // teardown of the short-lived smoke client.
    const close = client.close;
    if (typeof close === 'function') {
      await close.call(client).catch(() => undefined);
    }
  }
}

async function testReplay(config, outbound) {
  const event = {
    messageId: outbound.xmtpMessageId,
    senderInboxId: outbound.senderInboxId,
    conversationId: outbound.conversationId,
    content: JSON.stringify(outbound.payload),
    receivedAt: new Date().toISOString(),
  };
  for (let index = 0; index < 2; index += 1) {
    const { response, body } = await fetchJson(`${config.edgeUrl}/internal/v1/xmtp/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.internalSecret}` },
      body: JSON.stringify(event),
    });
    assert.ok([200, 202].includes(response.status), `replay event must be acknowledged, got ${response.status}`);
    assert.equal(body?.ok, true, 'replay acknowledgement must report ok=true');
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(2_000, config.pollIntervalMs * 2)));
  const rows = await findD1Records(config, {
    table: 'outbound_request',
    candidates: ['xmtp_message_id', 'xmtp_msg_id'],
    values: [outbound.xmtpMessageId],
  });
  assert.equal(rows.length, 1, 'replayed XMTP message must leave exactly one outbound_request');
  assert.equal(rows[0].status, 'sent', 'replayed sent request must remain sent');
  assert.equal(
    Number(rows[0].attempt_count),
    Number(outbound.record?.attempt_count),
    'replay must not create another provider-send attempt',
  );
  assert.equal(
    rows[0].provider_message_id,
    outbound.record?.provider_message_id,
    'replay must retain the original provider message ID',
  );
  return { xmtpMessageId: outbound.xmtpMessageId, record: scrubRecord(rows[0]) };
}

async function testContainerLifecycle(config, { path: endpointPath, requireR2Restore }) {
  const before = await getInternalStatus(config);
  const beforeState = extractContainerState(before);
  assert.ok(beforeState.pinnedInboxId, 'status must expose pinnedInboxId before a recovery drill');
  assert.equal(beforeState.currentInboxId, beforeState.pinnedInboxId, 'current and pinned inbox IDs must initially match');
  assert.ok(beforeState.installationId, 'status must expose installationId before a recovery drill');
  assert.equal(beforeState.currentInboxId, beforeState.configuredExpectedInboxId, 'current inbox must match configured expectation');
  assert.equal(beforeState.installationId, beforeState.configuredExpectedInstallationId, 'installation must match configured expectation');
  assert.ok(beforeState.bootId, 'status must expose bootId before a recovery drill');

  const { response, body } = await fetchJson(new URL(endpointPath, config.edgeUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.adminToken}` },
    body: JSON.stringify({
      confirm: config.expectedContainerName,
      expectedInboxId: beforeState.pinnedInboxId,
    }),
    timeoutMs: 180_000,
  });
  assert.ok(
    [200, 202, 204].includes(response.status) || (response.status === 503 && body?.action),
    `lifecycle request failed (${response.status}): ${JSON.stringify(body)}`,
  );

  const after = await waitFor(
    async () => {
      const status = await getInternalStatus(config).catch(() => null);
      if (!status) return null;
      const state = extractContainerState(status);
      return state.ready && state.bootId && state.bootId !== beforeState.bootId ? status : null;
    },
    {
      timeoutMs: Math.max(config.waitTimeoutMs, 300_000),
      intervalMs: config.pollIntervalMs,
      label: `Container to recover after ${endpointPath}`,
    },
  );
  const afterState = extractContainerState(after);
  assert.equal(afterState.currentInboxId, beforeState.pinnedInboxId, 'recovered client must use the pinned inbox ID');
  assert.equal(afterState.installationId, beforeState.installationId, 'recovery must not register a new XMTP installation');
  assert.equal(afterState.currentInboxId, afterState.configuredExpectedInboxId, 'recovered inbox must match configured expectation');
  assert.equal(afterState.installationId, afterState.configuredExpectedInstallationId, 'recovered installation must match configured expectation');
  if (requireR2Restore) {
    assert.ok(afterState.restoredAt, 'fresh filesystem recovery must report an R2 restoredAt timestamp');
    assert.ok(afterState.snapshotKey, 'fresh filesystem recovery must report its R2 snapshot key');
    assert.ok(afterState.snapshotHash, 'fresh filesystem recovery must report its verified snapshot hash');
  }
  return { before: beforeState, after: afterState };
}

async function createSmokeXmtpClient({ key, dbPath, env, allowNewInstallation }) {
  const { Client, IdentifierKind } = await import('@xmtp/node-sdk');
  const privateKey = key.startsWith('0x') ? key : `0x${key}`;
  const wallet = new ethers.Wallet(privateKey);
  const identifier = { identifier: wallet.address, identifierKind: IdentifierKind.Ethereum };
  const signer = {
    type: 'EOA',
    signMessage: async (message) => ethers.utils.arrayify(await wallet.signMessage(message)),
    getIdentifier: () => identifier,
  };
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const dbEncryptionKey = crypto.createHash('sha256').update(ethers.utils.arrayify(privateKey)).digest();
  const client = await Client.create(signer, {
    env,
    dbPath,
    dbEncryptionKey,
    disableAutoRegister: true,
  });
  if (!client.isRegistered) {
    if (!allowNewInstallation) {
      throw new Error(
        'Smoke-test XMTP database is not registered; refusing implicit installation creation',
      );
    }
    await client.register();
    if (!client.isRegistered) throw new Error('Explicit smoke-test installation registration failed');
  }
  return client;
}

async function resolveAddress(value, rpcUrl) {
  const addressOrEns = requireValue(value, 'SMOKE_XMTP_BOT_ADDRESS');
  if (ethers.utils.isAddress(addressOrEns)) return ethers.utils.getAddress(addressOrEns);
  if (!addressOrEns.endsWith('.eth')) throw new Error('SMOKE_XMTP_BOT_ADDRESS must be an address or .eth name');
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, { name: 'homestead', chainId: 1 });
  const resolved = await provider.resolveName(addressOrEns);
  if (!resolved) throw new Error(`Could not resolve ${addressOrEns}`);
  return ethers.utils.getAddress(resolved);
}

async function getInternalStatus(config) {
  const { response, body } = await fetchJson(`${config.edgeUrl}/internal/v1/status`, {
    headers: { authorization: `Bearer ${config.adminToken}` },
  });
  if (!response.ok || body?.ok !== true) {
    throw new Error(`Internal status failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body.status ?? body;
}

export function extractContainerState(status) {
  const container = status.container ?? status.relay?.container ?? status;
  const source = container.relay?.status ?? container.relay ?? container;
  return {
    name: container.instanceName ?? source.name ?? source.containerName ?? status.containerName,
    ready: Boolean(source.ready ?? source.xmtpReady ?? source.state === 'ready'),
    stream: source.stream ?? source.streamState ?? source.xmtpStream,
    bootId: source.bootId ?? source.boot_id,
    pinnedInboxId: source.pinnedInboxId ?? source.pinned_inbox_id,
    currentInboxId: source.currentInboxId ?? source.inboxId ?? source.current_inbox_id,
    installationId: source.installationId ?? source.installation_id,
    configuredExpectedInboxId: source.configuredExpectedInboxId ?? source.configured_expected_inbox_id,
    configuredExpectedInstallationId: source.configuredExpectedInstallationId ?? source.configured_expected_installation_id,
    restoredAt: source.recovery?.restoredAt ?? source.restoredAt ?? source.restored_at,
    snapshotKey: source.recovery?.manifestKey ?? source.recovery?.snapshotKey ?? source.snapshotKey ?? source.snapshot_key,
    snapshotHash: source.recovery?.sha256 ?? source.recovery?.snapshotHash ?? source.snapshotHash ?? source.snapshot_hash,
  };
}

async function findD1Records(config, { table, candidates, values }) {
  const columns = await d1Columns(config, table);
  const usable = candidates.filter((candidate) => columns.has(candidate));
  if (usable.length === 0) {
    throw new Error(`${table} has none of the expected lookup columns: ${candidates.join(', ')}`);
  }
  for (const column of usable) {
    for (const value of values) {
      const rows = await d1Query({
        ...config.d1,
        sql: `SELECT * FROM ${safeSqlName(table)} WHERE ${safeSqlName(column)} = ?`,
        params: [value],
      });
      if (rows.length > 0) return rows;
    }
  }
  return [];
}

async function waitForD1Records(config, options) {
  return waitFor(
    async () => {
      const rows = await findD1Records(config, options);
      return options.predicate(rows) ? rows : null;
    },
    {
      timeoutMs: config.waitTimeoutMs,
      intervalMs: config.pollIntervalMs,
      label: options.label,
    },
  );
}

async function d1Columns(config, table) {
  const rows = await d1Query({ ...config.d1, sql: `PRAGMA table_info(${safeSqlName(table)})` });
  const names = new Set(rows.map((row) => row.name).filter((name) => typeof name === 'string'));
  if (names.size === 0) throw new Error(`D1 table ${table} is missing or has no columns`);
  return names;
}

async function assertSingleInboundDeliveryJob(config, record) {
  const rows = await d1Query({
    ...config.d1,
    sql: 'SELECT * FROM delivery_job WHERE kind = ? AND record_key = ?',
    params: ['email.inbound.v1', String(record.id)],
  });
  assert.equal(rows.length, 1, 'duplicate inbound delivery must map to one durable XMTP job');
  assert.equal(rows[0].status, 'delivered', 'inbound XMTP job must be recorded as delivered');
  assert.ok(rows[0].xmtp_message_id, 'delivered inbound job must record the XMTP message ID');
  return rows[0];
}

function isDelivered(row) {
  const status = String(row.status ?? row.delivery_status ?? '').toLowerCase();
  return ['delivered', 'sent', 'completed', 'succeeded'].includes(status) || Boolean(row.delivered_at ?? row.xmtp_sent_at ?? row.sent_at);
}

function safeSqlName(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function firstPresent(values, candidates) {
  return candidates.find((candidate) => values.has(candidate));
}

function scrubRecord(record) {
  const allowed = [
    'id', 'dedupe_key', 'message_id', 'xmtp_message_id', 'xmtp_msg_id', 'status',
    'created_at', 'updated_at', 'delivered_at', 'attempt_count', 'last_error', 'provider_message_id',
  ];
  return Object.fromEntries(allowed.filter((key) => key in record).map((key) => [key, record[key]]));
}

function requireD1(config) {
  requireValue(config.accountId, 'CLOUDFLARE_ACCOUNT_ID');
  requireValue(config.databaseId, 'SMOKE_D1_DATABASE_ID');
  requireValue(config.apiToken, 'CLOUDFLARE_API_TOKEN');
}

function requireRecoveryConfirmation(args, config) {
  if (args.confirm !== config.expectedContainerName) {
    throw new Error(
      `Recovery tests deliberately restart/replace the production Container. Re-run with --confirm ${config.expectedContainerName}`,
    );
  }
  if (config.expectedContainerName !== PRODUCTION_CONTAINER_NAME) {
    throw new Error(`Recovery tests require the canonical Container identity ${PRODUCTION_CONTAINER_NAME}`);
  }
}

function normalizeXmtpEnv(value) {
  if (value === 'dev' || value === 'local' || value === 'production') return value;
  return 'production';
}

function splitCsv(value) {
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'y'].includes(String(value ?? '').trim().toLowerCase());
}

function printHelp() {
  console.log(`Usage: node scripts/cloudflare-smoke.mjs [options]

Options:
  --suite safe        Health, private-route auth, frontend, and DNS (default)
  --suite local       A-E application paths against wrangler dev/local Email Worker
  --suite production  A-E plus frontend and DNS using real SMTP/XMTP/email delivery
  --suite recovery    Destructive F/G Container recovery drills
  --suite all         All production and recovery checks (A-G, I, J)
  --confirm ${PRODUCTION_CONTAINER_NAME}
                      Required for recovery or all
  --json              Emit a machine-readable result

Required inputs are read from environment variables. The runbook documents the
full list. Secrets are never printed.

Acceptance H is deterministic and does not require a production failure hook:
  cf-worker/node_modules/.bin/vitest run --config tests/vitest.config.mjs tests/cloudflare-queues.test.ts`);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  await runSuite(args);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
