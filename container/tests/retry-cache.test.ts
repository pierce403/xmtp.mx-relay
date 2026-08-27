import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedRecentSet } from '../src/bounded-recent-set.js';
import { retryUntilSuccess } from '../src/retry.js';

test('recent XMTP message IDs remain bounded while collapsing overlap', () => {
  const seen = new BoundedRecentSet(3);
  assert.equal(seen.checkAndAdd('a'), false);
  assert.equal(seen.checkAndAdd('a'), true);
  assert.equal(seen.checkAndAdd('b'), false);
  assert.equal(seen.checkAndAdd('c'), false);
  assert.equal(seen.checkAndAdd('d'), false);
  assert.equal(seen.size, 3);
  assert.equal(seen.has('a'), false);
  assert.equal(seen.has('d'), true);
});

test('edge persistence retries beyond eight failures and preserves source order', async () => {
  const controller = new AbortController();
  const persisted: string[] = [];
  const attempts: Record<string, number> = { first: 0, second: 0 };
  const deliver = async (id: 'first' | 'second', failures: number) => retryUntilSuccess({
    signal: controller.signal,
    shouldStop: () => false,
    wait: async () => undefined,
    onRetry: () => undefined,
    operation: async () => {
      attempts[id] += 1;
      if (attempts[id] <= failures) throw new Error('transient edge failure');
      persisted.push(id);
    },
  });

  // This mirrors the child stream's awaited, sequential handler. The later
  // event cannot persist (and advance its watermark) before the failed one.
  assert.equal(await deliver('first', 12), true);
  assert.equal(await deliver('second', 0), true);
  assert.equal(attempts.first, 13);
  assert.deepEqual(persisted, ['first', 'second']);
});

test('edge retry exits without success only when shutdown aborts', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const result = retryUntilSuccess({
    signal: controller.signal,
    shouldStop: () => controller.signal.aborted,
    wait: async (_milliseconds, signal) => {
      controller.abort(new Error('shutdown'));
      if (signal.aborted) throw signal.reason;
    },
    onRetry: () => undefined,
    operation: async () => {
      attempts += 1;
      throw new Error('edge unavailable');
    },
  });
  assert.equal(await result, false);
  assert.equal(attempts, 1);
});
