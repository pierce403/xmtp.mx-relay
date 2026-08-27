export type RetryUntilSuccessOptions = {
  operation: (attempt: number) => Promise<void>;
  signal: AbortSignal;
  shouldStop: () => boolean;
  onRetry: (error: unknown, attempt: number) => void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  initialDelayMs?: number;
  maxDelayMs?: number;
};

export async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
  await new Promise<void>((resolve, reject) => {
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason ?? new Error('aborted')));
    const timer = setTimeout(() => finish(resolve), milliseconds);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Deliberately has no attempt limit. The caller must not acknowledge or move a
 * source watermark past an event until this returns true. Shutdown/abort is the
 * only non-success exit; a replacement child then replays from the old cutoff.
 */
export async function retryUntilSuccess(options: RetryUntilSuccessOptions): Promise<boolean> {
  const wait = options.wait ?? abortableDelay;
  const initialDelayMs = options.initialDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  let attempt = 0;

  while (!options.shouldStop() && !options.signal.aborted) {
    attempt += 1;
    try {
      await options.operation(attempt);
      return true;
    } catch (error) {
      if (options.shouldStop() || options.signal.aborted) return false;
      options.onRetry(error, attempt);
      const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.min(attempt - 1, 20));
      try {
        await wait(delay, options.signal);
      } catch (waitError) {
        if (options.shouldStop() || options.signal.aborted) return false;
        throw waitError;
      }
    }
  }
  return false;
}
