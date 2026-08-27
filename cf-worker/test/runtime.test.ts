import { describe, expect, it } from 'vitest';
import type { RelayEnv } from '../src/bindings';
import { configuredContainerName } from '../src/runtime';

describe('singleton Container identity', () => {
  it('fails closed when production configuration names a second Container', () => {
    const env = {
      XMTP_ENV: 'production',
      CONTAINER_INSTANCE_NAME: 'xmtp-mx-relay-production-copy',
    } as RelayEnv;
    expect(() => configuredContainerName(env)).toThrow(/must be exactly xmtp-mx-relay-production/);
  });

  it('permits isolated names only outside XMTP production', () => {
    const env = {
      XMTP_ENV: 'dev',
      CONTAINER_INSTANCE_NAME: 'xmtp-mx-relay-dev-test',
    } as RelayEnv;
    expect(configuredContainerName(env)).toBe('xmtp-mx-relay-dev-test');
  });
});
