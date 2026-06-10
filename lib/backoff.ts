// -----------------------------------------------------------------------------
// Retry schedule for failed deliveries.
//
// The base delay grows exponentially across attempts (30s, 60s, 120s, 300s,
// 600s), then caps at 600s for any further retries. A small per-attempt
// jitter is added to spread out simultaneous retries -- see thundering-herd
// note below.
//
// max_attempts on the deliveries table defaults to 5, so an attempt index of
// 0..4 corresponds to retries-after-failure-1 through retries-after-failure-5.
// -----------------------------------------------------------------------------

/**
 * Base delays, in seconds, for retries 1..5. Beyond index 4 we keep using
 * the last value (600s = 10 minutes), so a higher max_attempts setting
 * would just keep the cap.
 */
export const RETRY_DELAYS_SECONDS = [30, 60, 120, 300, 600] as const;

/**
 * Maximum jitter added on top of the base delay, in seconds. Uniform random
 * in [0, MAX_JITTER_SECONDS).
 *
 * Why jitter at all: when a downstream receiver goes down and comes back,
 * every failed delivery from the outage hits its retry timestamp at the
 * same moment. Without jitter, the worker fires them all in one batch --
 * a synchronised stampede that can knock the receiver down again. Jitter
 * spreads those retries across a small window so the receiver sees a
 * gentle ramp instead of a wall.
 */
export const MAX_JITTER_SECONDS = 10;

/**
 * Compute the delay (in seconds) before the next retry, given how many
 * attempts have already been made.
 *
 * attemptCount=0 -> 30s + jitter   (after the first failure)
 * attemptCount=1 -> 60s + jitter
 * attemptCount=2 -> 120s + jitter
 * attemptCount=3 -> 300s + jitter
 * attemptCount=4+ -> 600s + jitter (capped)
 *
 * Math.random() is fine here -- this is operational randomness for load
 * spreading, not security-sensitive randomness. Predictable jitter still
 * reduces synchronisation; truly random jitter is a small further win that
 * doesn't justify a CSPRNG call on a hot path.
 */
export function nextRetryDelay(attemptCount: number): number {
  const idx = Math.min(Math.max(attemptCount, 0), RETRY_DELAYS_SECONDS.length - 1);
  const base = RETRY_DELAYS_SECONDS[idx]!;
  const jitter = Math.random() * MAX_JITTER_SECONDS;
  return base + jitter;
}

/**
 * Compute the absolute timestamp of the next retry, given how many attempts
 * have already been made. Convenience over `nextRetryDelay` for callers that
 * write `next_attempt_at` straight into the deliveries table.
 */
export function nextAttemptAt(attemptCount: number): Date {
  const delaySeconds = nextRetryDelay(attemptCount);
  return new Date(Date.now() + delaySeconds * 1000);
}
