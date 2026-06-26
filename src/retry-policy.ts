/**
 * Configuration for connection retry behavior.
 */
export interface RetryPolicyOptions {
  /** Maximum number of retry attempts. Default: 3 */
  maxRetries?: number;
  /** Initial delay between retries in ms. Default: 1000 */
  initialDelayMs?: number;
  /** Multiplier for exponential backoff. Default: 2 */
  backoffMultiplier?: number;
  /** Maximum delay between retries in ms. Default: 30000 */
  maxDelayMs?: number;
}

const DEFAULT_RETRY: Required<RetryPolicyOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 30_000,
};

/**
 * Executes an async operation with exponential backoff retry.
 *
 * @example
 * ```ts
 * await withRetry(() => provider.connect(connectionString), { maxRetries: 5 });
 * ```
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options?: RetryPolicyOptions,
): Promise<T> {
  const opts = { ...DEFAULT_RETRY, ...options };
  let lastError: Error | undefined;
  let delay = opts.initialDelayMs;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt >= opts.maxRetries) break;

      // Wait with exponential backoff
      await sleep(delay);
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }

  throw new Error(
    `Operation failed after ${opts.maxRetries + 1} attempts. Last error: ${lastError?.message}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
