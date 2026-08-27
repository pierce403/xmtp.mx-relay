import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type pino from 'pino';
import { ZodError } from 'zod';
import { isAuthorized } from './auth.js';
import { deliveryRequestSchema } from './protocol.js';
import type { XmtpSupervisor } from './supervisor.js';

class RequestBodyTooLargeError extends Error {}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw new RequestBodyTooLargeError(`request body exceeds ${maxBytes} bytes`);
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new SyntaxError('request body is not valid JSON');
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function authorizationHeader(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return Array.isArray(value) ? value[0] : value;
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RequestBodyTooLargeError) return 413;
  if (error instanceof SyntaxError || error instanceof ZodError) return 400;
  if (message === 'job_id_payload_conflict') return 409;
  if (message === 'xmtp_payload_too_large') return 413;
  if (message === 'xmtp_conversation_not_found') return 404;
  if (message.includes('not_ready') || message.includes('not_connected')) return 503;
  if (message.includes('timeout')) return 504;
  return 500;
}

function publicError(error: unknown, status: number): string {
  if (error instanceof ZodError) return 'invalid_request';
  if (status >= 500) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('xmtp_') || message.startsWith('supervisor_')) return message;
    return 'internal_error';
  }
  return error instanceof Error ? error.message : String(error);
}

export function createHttpServer(args: {
  supervisor: XmtpSupervisor;
  sharedSecret: string;
  maxRequestBodyBytes: number;
  log: pino.Logger;
}): http.Server {
  const { supervisor, sharedSecret, maxRequestBodyBytes, log } = args;

  return http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/livez') {
        sendJson(response, 200, {
          ok: true,
          live: true,
          bootId: supervisor.state.bootId,
          startedAt: supervisor.state.startedAt,
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/healthz') {
        const status = supervisor.state.publicStatus();
        sendJson(response, status.ok === true ? 200 : 503, status);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/readyz') {
        const ready = supervisor.state.isReady();
        sendJson(response, ready ? 200 : 503, supervisor.state.publicStatus());
        return;
      }

      if (!url.pathname.startsWith('/internal/')) {
        sendJson(response, 404, { ok: false, error: 'not_found' });
        return;
      }
      if (!isAuthorized(authorizationHeader(request), sharedSecret)) {
        sendJson(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/internal/v1/status') {
        sendJson(response, 200, supervisor.internalStatus());
        return;
      }

      if (request.method === 'POST' && url.pathname === '/internal/v1/xmtp/deliver') {
        const input = deliveryRequestSchema.parse(await readJsonBody(request, maxRequestBodyBytes));
        const result = await supervisor.deliver(input);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/internal/v1/admin/backup') {
        const input = (await readJsonBody(request, 16 * 1024)) as { reason?: unknown };
        const reason = typeof input.reason === 'string' ? input.reason.slice(0, 200) : 'manual';
        const manifest = await supervisor.backup(reason);
        sendJson(response, 200, {
          ok: true,
          snapshotId: manifest.snapshotId,
          createdAt: manifest.createdAt,
          inboxId: manifest.inboxId,
          installationId: manifest.installationId,
          databaseSha256: manifest.database.sha256,
        });
        return;
      }

      sendJson(response, 404, { ok: false, error: 'not_found' });
    })().catch((error) => {
      const status = errorStatus(error);
      log.error(
        {
          error,
          method: request.method,
          path: request.url?.split('?')[0] ?? null,
          status,
        },
        'http.request_failed',
      );
      if (!response.headersSent) sendJson(response, status, { ok: false, error: publicError(error, status) });
      else response.destroy();
    });
  });
}

export async function listen(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}
