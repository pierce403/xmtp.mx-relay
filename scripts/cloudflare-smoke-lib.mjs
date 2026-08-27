import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export function parsePositiveInteger(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function requireValue(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`Missing required setting: ${name}`);
  return normalized;
}

export function normalizeBaseUrl(value, name) {
  const url = new URL(requireValue(value, name));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http: or https:`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function makeCorrelationId(prefix = 'xmtp-mx-smoke') {
  const random = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  return `${prefix}-${Date.now()}-${random}`;
}

export function buildInboundEmail({ correlationId, from, to }) {
  assertSafeMailbox(from, 'inbound sender');
  assertSafeMailbox(to, 'inbound recipient');
  const safeId = requireValue(correlationId, 'correlationId').replace(/[^a-zA-Z0-9._-]/g, '-');
  const messageId = `<${safeId}@smoke.xmtp.mx>`;
  const subject = `xmtp.mx inbound smoke ${safeId}`;
  const text = `Cloudflare inbound smoke test ${safeId}`;
  const html = `<p>Cloudflare inbound smoke test <strong>${safeId}</strong></p>`;
  const raw = [
    `From: xmtp.mx smoke <${from}>`,
    `To: ${to}`,
    `Reply-To: ${from}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="xmtp-mx-smoke-boundary"',
    '',
    '--xmtp-mx-smoke-boundary',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    '--xmtp-mx-smoke-boundary',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    '--xmtp-mx-smoke-boundary--',
    '',
  ].join('\r\n');
  return { messageId, subject, text, html, raw };
}

export function buildEmailSendV1({ correlationId, to, cc = [], bcc = [], replyTo = null }) {
  const recipients = { to, cc, bcc };
  for (const [kind, values] of Object.entries(recipients)) {
    if (!Array.isArray(values)) throw new Error(`${kind} must be an array`);
    for (const address of values) assertSafeMailbox(address, `${kind} recipient`);
  }
  if (to.length === 0) throw new Error('At least one to recipient is required');
  if (replyTo !== null) assertSafeMailbox(replyTo, 'replyTo');
  const id = requireValue(correlationId, 'correlationId');
  return {
    type: 'email.send.v1',
    to,
    cc,
    bcc,
    subject: `xmtp.mx outbound smoke ${id}`,
    text: `Cloudflare outbound smoke test ${id}`,
    html: `<p>Cloudflare outbound smoke test <strong>${escapeHtml(id)}</strong></p>`,
    replyTo,
  };
}

export function parseEmailSendResult(content) {
  if (typeof content !== 'string') return null;
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || value.type !== 'email.send.result.v1') return null;
  if (typeof value.ok !== 'boolean') return null;
  return value;
}

export async function fetchJson(url, options = {}) {
  const timeoutMs = parsePositiveInteger(options.timeoutMs, 'timeoutMs', 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      signal: controller.signal,
    });
    const raw = await response.text();
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { raw };
      }
    }
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function waitFor(check, options = {}) {
  const timeoutMs = parsePositiveInteger(options.timeoutMs, 'timeoutMs', DEFAULT_TIMEOUT_MS);
  const intervalMs = parsePositiveInteger(options.intervalMs, 'intervalMs', DEFAULT_POLL_INTERVAL_MS);
  const label = options.label || 'condition';
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.${suffix}`);
}

export async function assertHealth({ edgeUrl, adminToken, secret, expectedContainerName }) {
  const token = requireValue(adminToken ?? secret, 'adminToken');
  const publicHealth = await fetchJson(`${edgeUrl}/healthz`);
  assert.equal(publicHealth.response.status, 200, 'GET /healthz must return 200');
  assert.equal(publicHealth.body?.ok, true, 'GET /healthz must report ok=true');

  const unauthorized = await fetchJson(`${edgeUrl}/internal/v1/status`);
  assert.ok(
    unauthorized.response.status === 401 || unauthorized.response.status === 403,
    `unauthenticated internal status must return 401/403, got ${unauthorized.response.status}`,
  );

  const authorized = await fetchJson(`${edgeUrl}/internal/v1/status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(authorized.response.status, 200, 'authenticated internal status must return 200');
  assert.equal(authorized.body?.ok, true, 'internal status must report ok=true');

  const status = authorized.body?.status ?? authorized.body;
  const containerName = findFirst(status, [
    ['container', 'instanceName'],
    ['container', 'name'],
    ['containerName'],
    ['relay', 'containerName'],
    ['name'],
  ]);
  if (containerName !== undefined) {
    assert.equal(containerName, expectedContainerName, 'unexpected production Container identity');
  }
  const pinnedInboxId = findFirst(status, [
    ['container', 'relay', 'pinnedInboxId'],
    ['container', 'pinnedInboxId'],
    ['xmtp', 'pinnedInboxId'],
    ['pinnedInboxId'],
  ]);
  const currentInboxId = findFirst(status, [
    ['container', 'relay', 'currentInboxId'],
    ['container', 'currentInboxId'],
    ['xmtp', 'currentInboxId'],
    ['currentInboxId'],
  ]);
  if (pinnedInboxId !== undefined || currentInboxId !== undefined) {
    assert.ok(pinnedInboxId, 'status must expose a non-empty pinned inbox ID');
    assert.ok(currentInboxId, 'status must expose a non-empty current inbox ID');
    assert.equal(currentInboxId, pinnedInboxId, 'restored XMTP inbox must match the pinned inbox');
  }
  const expectedInboxId = findFirst(status, [
    ['container', 'relay', 'configuredExpectedInboxId'],
    ['configuredExpectedInboxId'],
  ]);
  const installationId = findFirst(status, [
    ['container', 'relay', 'installationId'],
    ['installationId'],
  ]);
  const expectedInstallationId = findFirst(status, [
    ['container', 'relay', 'configuredExpectedInstallationId'],
    ['configuredExpectedInstallationId'],
  ]);
  if (expectedInboxId !== undefined) {
    assert.ok(expectedInboxId, 'production status must expose the configured expected inbox ID');
    assert.equal(currentInboxId, expectedInboxId, 'current XMTP inbox must match configured expectation');
  }
  if (expectedInstallationId !== undefined) {
    assert.ok(expectedInstallationId, 'production status must expose the configured expected installation ID');
    assert.equal(installationId, expectedInstallationId, 'current XMTP installation must match configured expectation');
  }
  return authorized.body;
}

export async function dispatchLocalEmail({ edgeUrl, from, to, raw }) {
  const url = new URL('/cdn-cgi/handler/email', edgeUrl);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'message/rfc822' },
    body: raw,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Local Email Worker dispatch failed (${response.status}): ${body.slice(0, 500)}`);
  }
  return body;
}

export async function d1Query({ accountId, databaseId, apiToken, sql, params = [] }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
  const { response, body } = await fetchJson(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!response.ok || body?.success !== true) {
    throw new Error(`D1 query failed (${response.status}): ${JSON.stringify(body?.errors ?? body)}`);
  }
  const first = body.result?.[0];
  return first?.results ?? [];
}

export async function verifyEmailDns(domain, options = {}) {
  const mx = await dns.resolveMx(domain);
  assert.ok(mx.length >= 1, `${domain} must have MX records`);
  assert.ok(
    mx.every((record) => record.exchange.toLowerCase().replace(/\.$/, '').endsWith('.mx.cloudflare.net')),
    `${domain} MX records must all point to Cloudflare Email Routing`,
  );

  const rootTxt = flattenTxt(await dns.resolveTxt(domain));
  const spf = rootTxt.filter((record) => record.toLowerCase().startsWith('v=spf1'));
  assert.equal(spf.length, 1, `${domain} must publish exactly one SPF record`);
  assert.match(spf[0], /include:_spf\.mx\.cloudflare\.net/i, 'root SPF must authorize Cloudflare Email Service');

  const bounce = `cf-bounce.${domain}`;
  const bounceMx = await dns.resolveMx(bounce);
  assert.ok(
    bounceMx.length >= 1 && bounceMx.every((record) => record.exchange.toLowerCase().replace(/\.$/, '').endsWith('.mx.cloudflare.net')),
    `${bounce} MX records must point to Cloudflare`,
  );
  const bounceTxt = flattenTxt(await dns.resolveTxt(bounce));
  const bounceSpf = bounceTxt.filter((record) => record.toLowerCase().startsWith('v=spf1'));
  assert.equal(bounceSpf.length, 1, `${bounce} must publish exactly one SPF record`);
  assert.match(bounceSpf[0], /include:_spf\.mx\.cloudflare\.net/i, 'bounce SPF must authorize Cloudflare');

  const sendingDkimName = options.sendingDkimName || `cf-bounce._domainkey.${domain}`;
  const routingDkimName = options.routingDkimName || `cf2024-1._domainkey.${domain}`;
  for (const name of [sendingDkimName, routingDkimName]) {
    const records = flattenTxt(await dns.resolveTxt(name));
    assert.ok(records.some((record) => /\bv=DKIM1\b/i.test(record)), `${name} must publish a DKIM1 record`);
  }

  const dmarcName = `_dmarc.${domain}`;
  const dmarc = flattenTxt(await dns.resolveTxt(dmarcName));
  assert.ok(dmarc.some((record) => /^v=DMARC1\b/i.test(record)), `${dmarcName} must publish a DMARC record`);

  return { mx, spf: spf[0], bounceMx, bounceSpf: bounceSpf[0], sendingDkimName, routingDkimName, dmarcName };
}

export function parseSmtpUrl(value) {
  const url = new URL(requireValue(value, 'SMOKE_SMTP_URL'));
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
    throw new Error('SMOKE_SMTP_URL must use smtp: or smtps:');
  }
  const secure = url.protocol === 'smtps:';
  const port = url.port ? parsePositiveInteger(url.port, 'SMTP port') : secure ? 465 : 587;
  return {
    host: url.hostname,
    port,
    secure,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

export async function sendSmtp({ smtpUrl, from, to, raw, insecureTls = false, timeoutMs = 30_000 }) {
  assertSafeMailbox(from, 'SMTP MAIL FROM');
  assertSafeMailbox(to, 'SMTP RCPT TO');
  const settings = parseSmtpUrl(smtpUrl);
  let socket = settings.secure
    ? tls.connect({ host: settings.host, port: settings.port, servername: settings.host, rejectUnauthorized: !insecureTls })
    : net.connect({ host: settings.host, port: settings.port });
  socket.setTimeout(timeoutMs);
  socket.on('timeout', () => socket.destroy(new Error(`SMTP socket timed out after ${timeoutMs}ms`)));

  let reader = createSmtpReader(socket);
  await waitForSocket(socket, settings.secure ? 'secureConnect' : 'connect');
  await expectSmtp(reader, [220], 'server greeting');
  let ehlo = await smtpCommand(socket, reader, 'EHLO smoke.xmtp.mx', [250]);

  if (!settings.secure && ehlo.lines.some((line) => /\bSTARTTLS\b/i.test(line))) {
    await smtpCommand(socket, reader, 'STARTTLS', [220]);
    reader.detach();
    socket = tls.connect({ socket, servername: settings.host, rejectUnauthorized: !insecureTls });
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => socket.destroy(new Error(`SMTP TLS socket timed out after ${timeoutMs}ms`)));
    reader = createSmtpReader(socket);
    await waitForSocket(socket, 'secureConnect');
    ehlo = await smtpCommand(socket, reader, 'EHLO smoke.xmtp.mx', [250]);
  }

  if (settings.username || settings.password) {
    if (!settings.username || !settings.password) {
      throw new Error('SMOKE_SMTP_URL must include both username and password when authentication is used');
    }
    const auth = Buffer.from(`\0${settings.username}\0${settings.password}`).toString('base64');
    await smtpCommand(socket, reader, `AUTH PLAIN ${auth}`, [235]);
  }

  await smtpCommand(socket, reader, `MAIL FROM:<${from}>`, [250]);
  await smtpCommand(socket, reader, `RCPT TO:<${to}>`, [250, 251]);
  await smtpCommand(socket, reader, 'DATA', [354]);
  const normalized = raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..').replace(/\r\n$/, '');
  socket.write(`${normalized}\r\n.\r\n`);
  const accepted = await expectSmtp(reader, [250], 'message acceptance');
  await smtpCommand(socket, reader, 'QUIT', [221]).catch(() => undefined);
  socket.end();
  return accepted;
}

function createSmtpReader(socket) {
  let buffer = '';
  const lines = [];
  const waiters = [];
  let terminalError = null;

  const pump = () => {
    while (waiters.length && lines.length) waiters.shift().resolve(lines.shift());
    if (terminalError) {
      while (waiters.length) waiters.shift().reject(terminalError);
    }
  };
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      lines.push(buffer.slice(0, end).replace(/\r$/, ''));
      buffer = buffer.slice(end + 1);
    }
    pump();
  };
  const onError = (error) => {
    terminalError = error;
    pump();
  };
  const onEnd = () => {
    terminalError ??= new Error('SMTP connection ended unexpectedly');
    pump();
  };
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('end', onEnd);

  return {
    readLine() {
      if (lines.length) return Promise.resolve(lines.shift());
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    detach() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      const error = new Error('SMTP reader replaced for TLS upgrade');
      while (waiters.length) waiters.shift().reject(error);
    },
  };
}

async function smtpCommand(socket, reader, command, expectedCodes) {
  socket.write(`${command}\r\n`);
  return expectSmtp(reader, expectedCodes, command.split(' ', 1)[0]);
}

async function expectSmtp(reader, expectedCodes, context) {
  const lines = [];
  let code = null;
  while (true) {
    const line = await reader.readLine();
    lines.push(line);
    const match = /^(\d{3})([ -])/.exec(line);
    if (!match) continue;
    code ??= Number(match[1]);
    if (match[2] === ' ' && Number(match[1]) === code) break;
  }
  if (!expectedCodes.includes(code)) {
    throw new Error(`SMTP ${context} failed (${code}): ${lines.join(' | ')}`);
  }
  return { code, lines };
}

function waitForSocket(socket, event) {
  if ((event === 'connect' && !socket.connecting) || (event === 'secureConnect' && socket.secureConnecting === false)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off(event, onReady);
      socket.off('error', onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.once(event, onReady);
    socket.once('error', onError);
  });
}

function findFirst(value, paths) {
  for (const path of paths) {
    let current = value;
    let found = true;
    for (const key of path) {
      if (!current || typeof current !== 'object' || !(key in current)) {
        found = false;
        break;
      }
      current = current[key];
    }
    if (found) return current;
  }
  return undefined;
}

function assertSafeMailbox(value, label) {
  const mailbox = requireValue(value, label);
  if (/\r|\n/.test(mailbox) || !/^[^\s@<>]+@[^\s@<>]+$/.test(mailbox)) {
    throw new Error(`Invalid ${label}: ${mailbox}`);
  }
}

function flattenTxt(records) {
  return records.map((parts) => parts.join(''));
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
