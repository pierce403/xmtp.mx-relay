import assert from 'node:assert/strict';
import net from 'node:net';
import { afterEach, describe, it } from 'node:test';
import {
  assertHealth,
  buildEmailSendV1,
  buildInboundEmail,
  d1Query,
  parseEmailSendResult,
  parseSmtpUrl,
  sendSmtp,
  waitFor,
} from '../scripts/cloudflare-smoke-lib.mjs';
import {
  extractContainerState,
  loadSmokeConfig,
  parseCliArgs,
} from '../scripts/cloudflare-smoke.mjs';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('wire fixtures', () => {
  it('requires the exact deployed Worker URL instead of assuming a relay hostname', () => {
    assert.throws(() => loadSmokeConfig({}), /SMOKE_EDGE_URL/);
    assert.equal(
      loadSmokeConfig({ SMOKE_EDGE_URL: 'https://edge.example.workers.dev/' }).edgeUrl,
      'https://edge.example.workers.dev',
    );
  });

  it('builds a stable RFC 5322 inbound fixture with both body representations', () => {
    const result = buildInboundEmail({
      correlationId: 'case-123',
      from: 'sender@example.com',
      to: 'deanpierce.eth@xmtp.mx',
    });

    assert.equal(result.messageId, '<case-123@smoke.xmtp.mx>');
    assert.match(result.raw, /^From: xmtp\.mx smoke <sender@example\.com>\r\n/);
    assert.match(result.raw, /Message-ID: <case-123@smoke\.xmtp\.mx>/);
    assert.match(result.raw, /Content-Type: text\/plain; charset=utf-8/);
    assert.match(result.raw, /Content-Type: text\/html; charset=utf-8/);
    assert.ok(result.raw.endsWith('\r\n'));
  });

  it('preserves to/cc/bcc/subject/text/html/replyTo in email.send.v1', () => {
    const payload = buildEmailSendV1({
      correlationId: 'case-456',
      to: ['to@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      replyTo: 'reply@example.com',
    });

    assert.deepEqual(payload.to, ['to@example.com']);
    assert.deepEqual(payload.cc, ['cc@example.com']);
    assert.deepEqual(payload.bcc, ['bcc@example.com']);
    assert.match(payload.subject, /case-456/);
    assert.match(payload.text, /case-456/);
    assert.match(payload.html, /case-456/);
    assert.equal(payload.replyTo, 'reply@example.com');
  });

  it('rejects mailbox header injection', () => {
    assert.throws(
      () => buildInboundEmail({ correlationId: 'x', from: 'a@example.com\r\nBcc: victim@example.com', to: 'b@example.com' }),
      /Invalid inbound sender/,
    );
    assert.throws(
      () => buildEmailSendV1({ correlationId: 'x', to: ['ok@example.com\nCc: victim@example.com'] }),
      /Invalid to recipient/,
    );
  });

  it('recognizes only email.send.result.v1 JSON results', () => {
    assert.deepEqual(
      parseEmailSendResult('{"type":"email.send.result.v1","ok":true,"mailgunId":"abc","error":null}'),
      { type: 'email.send.result.v1', ok: true, mailgunId: 'abc', error: null },
    );
    assert.equal(parseEmailSendResult('{"type":"email.send.v1","ok":true}'), null);
    assert.equal(parseEmailSendResult('not json'), null);
  });
});

describe('private edge contract', () => {
  it('requires authentication and verifies the restored inbox identity', async () => {
    const secret = 'test-shared-secret';
    const server = net.createServer((socket) => {
      let request = '';
      socket.on('data', (chunk) => {
        request += chunk.toString();
        if (!request.includes('\r\n\r\n')) return;
        const [firstLine, ...headers] = request.split('\r\n');
        const route = firstLine.split(' ')[1];
        const authorized = headers.some((line) => line.toLowerCase() === `authorization: bearer ${secret}`);
        let status = 200;
        let body;
        if (route === '/healthz') body = { ok: true };
        else if (!authorized) {
          status = 401;
          body = { ok: false, error: 'unauthorized' };
        } else {
          body = {
            ok: true,
            status: {
              container: {
                name: 'xmtp-mx-relay-production',
                pinnedInboxId: 'inbox-a',
                currentInboxId: 'inbox-a',
              },
            },
          };
        }
        const encoded = JSON.stringify(body);
        socket.end(
          `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Unauthorized'}\r\n` +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${Buffer.byteLength(encoded)}\r\nConnection: close\r\n\r\n${encoded}`,
        );
      });
    });
    servers.push(server);
    await listen(server);
    const address = server.address();
    const result = await assertHealth({
      edgeUrl: `http://127.0.0.1:${address.port}`,
      adminToken: secret,
      expectedContainerName: 'xmtp-mx-relay-production',
    });
    assert.equal(result.ok, true);
  });
});

describe('recovery status contract', () => {
  it('reads the verified snapshot digest published by the Container', () => {
    const state = extractContainerState({
      container: {
        instanceName: 'xmtp-mx-relay-production',
        relay: {
          ready: true,
          recovery: {
            manifestKey: 'xmtp/snapshots/example/manifest.json',
            sha256: 'a'.repeat(64),
            restoredAt: '2026-08-27T00:00:00.000Z',
          },
        },
      },
    });

    assert.equal(state.snapshotHash, 'a'.repeat(64));
    assert.equal(state.snapshotKey, 'xmtp/snapshots/example/manifest.json');
  });
});

describe('SMTP production injection', () => {
  it('sends an RFC message and dot-stuffs body lines', async () => {
    let data = '';
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.write('220 smoke.test ESMTP\r\n');
      let buffer = '';
      let inData = false;
      socket.on('data', (chunk) => {
        buffer += chunk;
        while (true) {
          const end = buffer.indexOf('\r\n');
          if (end < 0) return;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              socket.write('250 2.0.0 queued as smoke-id\r\n');
            } else {
              data += `${line}\r\n`;
            }
            continue;
          }
          if (line.startsWith('EHLO ')) socket.write('250-smoke.test\r\n250 SIZE 100000\r\n');
          else if (line.startsWith('MAIL FROM:')) socket.write('250 sender ok\r\n');
          else if (line.startsWith('RCPT TO:')) socket.write('250 recipient ok\r\n');
          else if (line === 'DATA') {
            inData = true;
            socket.write('354 end with dot\r\n');
          } else if (line === 'QUIT') socket.end('221 bye\r\n');
          else socket.write('500 unexpected\r\n');
        }
      });
    });
    servers.push(server);
    await listen(server);
    const address = server.address();
    const accepted = await sendSmtp({
      smtpUrl: `smtp://127.0.0.1:${address.port}`,
      from: 'sender@example.com',
      to: 'deanpierce.eth@xmtp.mx',
      raw: 'From: sender@example.com\r\nTo: deanpierce.eth@xmtp.mx\r\n\r\n.line one\r\nline two\r\n',
    });
    assert.equal(accepted.code, 250);
    assert.match(data, /\r\n\.\.line one\r\n/);
  });

  it('parses authenticated submission URLs without exposing credentials', () => {
    assert.deepEqual(parseSmtpUrl('smtps://user%40example.com:p%40ss@smtp.example.com:465'), {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      username: 'user@example.com',
      password: 'p@ss',
    });
  });
});

describe('D1 and polling helpers', () => {
  it('uses bound parameters for D1 queries', async () => {
    const originalFetch = globalThis.fetch;
    let captured;
    globalThis.fetch = async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ success: true, result: [{ results: [{ id: 7 }] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const rows = await d1Query({
        accountId: 'account',
        databaseId: 'database',
        apiToken: 'secret',
        sql: 'SELECT * FROM inbound_email WHERE message_id = ?',
        params: ['<id@example.com>'],
      });
      assert.deepEqual(rows, [{ id: 7 }]);
      assert.deepEqual(JSON.parse(captured.options.body).params, ['<id@example.com>']);
      assert.equal(captured.options.headers.authorization, 'Bearer secret');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('waits through transient errors', async () => {
    let calls = 0;
    const result = await waitFor(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return calls >= 3 ? 'ready' : null;
      },
      { timeoutMs: 1_000, intervalMs: 5, label: 'test' },
    );
    assert.equal(result, 'ready');
    assert.equal(calls, 3);
  });
});

describe('CLI guardrails', () => {
  it('defaults to non-destructive safe checks', () => {
    assert.deepEqual(parseCliArgs([]), { suite: 'safe', confirm: null, json: false });
  });

  it('parses an explicitly confirmed recovery drill', () => {
    assert.deepEqual(parseCliArgs(['--suite', 'recovery', '--confirm', 'xmtp-mx-relay-production', '--json']), {
      suite: 'recovery',
      confirm: 'xmtp-mx-relay-production',
      json: true,
    });
  });

  it('rejects unknown suites and flags', () => {
    assert.throws(() => parseCliArgs(['--suite', 'maybe']), /--suite must be one of/);
    assert.throws(() => parseCliArgs(['--destroy']), /Unknown argument/);
  });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}
