import type { RelayEnv } from './bindings';

export function requireContainerAuth(request: Request, env: RelayEnv): Response | null {
  return requireBearer(request, env.CONTAINER_SHARED_SECRET);
}

export function requireAdminAuth(request: Request, env: RelayEnv): Response | null {
  return requireBearer(request, env.RELAY_ADMIN_TOKEN);
}

export function requireRecoveryAuth(request: Request, env: RelayEnv): Response | null {
  return requireBearer(request, env.RECOVERY_ADMIN_TOKEN);
}

export function requireBearer(request: Request, expected: string | undefined): Response | null {
  const configured = expected?.trim() ?? '';
  const header = request.headers.get('authorization') ?? '';
  const candidate = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!configured || !constantTimeEqual(candidate, configured)) {
    return Response.json({ ok: false, error: 'unauthorized' }, {
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
    });
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const length = Math.max(aBytes.length, bBytes.length);
  let difference = aBytes.length ^ bBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (aBytes[index] ?? 0) ^ (bBytes[index] ?? 0);
  }
  return difference === 0;
}
