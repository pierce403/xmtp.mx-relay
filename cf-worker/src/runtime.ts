import type { RelayEnv } from './bindings';
import { InputError } from './protocol';

export const PRODUCTION_CONTAINER_NAME = 'xmtp-mx-relay-production';

export type WatchdogActivationState = {
  paused: boolean;
  at?: string;
  reason?: string;
};

export function isWatchdogActivationState(value: unknown): value is WatchdogActivationState {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { paused?: unknown }).paused === 'boolean',
  );
}

export function envInteger(
  value: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) return fallback;
  return parsed;
}

export function configuredContainerName(env: RelayEnv): string {
  const configured = env.CONTAINER_INSTANCE_NAME?.trim() || PRODUCTION_CONTAINER_NAME;
  if ((env.XMTP_ENV?.trim() || 'production') === 'production' && configured !== PRODUCTION_CONTAINER_NAME) {
    throw new Error(
      `Production XMTP Container name must be exactly ${PRODUCTION_CONTAINER_NAME}; refusing ${configured}`,
    );
  }
  return configured;
}

export async function readJsonWithLimit(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > maxBytes) throw new InputError('payload_too_large', 'Request body is too large');
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new InputError('payload_too_large', 'Request body is too large');
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InputError('invalid_json', 'Request body must be valid JSON');
  }
}

export function structuredLog(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === 'error') console.error(record);
  else if (level === 'warn') console.warn(record);
  else console.log(record);
}

export function errorMessage(error: unknown, maxLength = 1_000): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, maxLength);
}

export function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : null;
}
