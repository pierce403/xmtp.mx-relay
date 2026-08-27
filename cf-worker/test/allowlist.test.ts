import { describe, expect, it, vi } from 'vitest';
import type { RelayEnv } from '../src/bindings';
import { seedConfiguredAllowlist } from '../src/db';

describe('XMTP sender allowlist configuration', () => {
  it.each(['deanpierce.eth', '0x0123456789012345678901234567890123456789'])(
    'fails closed for unresolved legacy identity %s',
    async (identity) => {
      const batch = vi.fn();
      const env = {
        XMTP_ALLOWED_SENDERS: identity,
        RELAY_DB: { batch },
      } as unknown as RelayEnv;

      await expect(seedConfiguredAllowlist(env)).rejects.toThrow(/64-hex XMTP inbox IDs/);
      expect(batch).not.toHaveBeenCalled();
    },
  );

  it('removes senders revoked from the Wrangler configuration', async () => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    const batch = vi.fn().mockResolvedValue([]);
    const env = {
      XMTP_ALLOWED_SENDERS: '',
      RELAY_DB: {
        prepare(query: string) {
          const statement = {
            query,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              this.values = values;
              return this;
            },
          };
          statements.push(statement);
          return statement;
        },
        batch,
      },
    } as unknown as RelayEnv;

    await seedConfiguredAllowlist(env);

    expect(batch).toHaveBeenCalledOnce();
    expect(statements).toHaveLength(1);
    expect(statements[0]?.query).toContain("DELETE FROM allowlist_xmtp WHERE source = 'wrangler'");
  });
});
