import { getSql, type Sql } from './db.js';
import { nextAttemptAt } from './backoff.js';
import type {
  Delivery,
  DeliveryAttempt,
  DeliveryQuery,
  DeliveryStatus,
  DeliveryWithAttempts,
} from './types.js';
import type { DeliveryAttemptResult } from './deliver.js';

// -----------------------------------------------------------------------------
// Worker-facing shapes
// -----------------------------------------------------------------------------

/**
 * Everything the worker needs to attempt one delivery, gathered in a single
 * claim query: the delivery's own bookkeeping columns plus the event payload
 * and the destination URL + signing secret joined in from the related rows.
 *
 * This is deliberately NOT the public Delivery type -- it carries the secret
 * and the raw payload, which never leave the worker. snake_case mirrors the
 * SELECT, mapped to camelCase by toClaimedDelivery.
 */
export interface ClaimedDelivery {
  id: string;
  eventId: string;
  subscriptionId: string;
  attemptCount: number;
  maxAttempts: number;
  eventType: string;
  payload: Record<string, unknown>;
  url: string;
  secret: string;
  /** Subscription state at claim time -- the worker uses these to decide */
  /** whether the destination is still a valid delivery target. */
  enabled: boolean;
  deletedAt: string | null;
}

interface DbClaimedDelivery {
  id: string;
  event_id: string;
  subscription_id: string;
  attempt_count: number;
  max_attempts: number;
  event_type: string;
  payload: Record<string, unknown>;
  url: string;
  secret: string;
  enabled: boolean;
  deleted_at: Date | string | null;
}

function toClaimedDelivery(r: DbClaimedDelivery): ClaimedDelivery {
  return {
    id: r.id,
    eventId: r.event_id,
    subscriptionId: r.subscription_id,
    attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts,
    eventType: r.event_type,
    payload: r.payload,
    url: r.url,
    secret: r.secret,
    enabled: r.enabled,
    deletedAt: r.deleted_at === null ? null : new Date(r.deleted_at).toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Atomic claim -- "the deliveries table IS the queue"
//
// One statement does three things atomically:
//   1. Select up to `limit` deliveries that are pending and due
//      (next_attempt_at <= now()), oldest first.
//   2. FOR UPDATE SKIP LOCKED -- take a row lock on each, and skip any row
//      another worker has already locked. This is what makes concurrent
//      workers safe: two workers running at the same instant claim disjoint
//      sets, never the same row, and neither blocks waiting on the other.
//   3. Flip the claimed rows to status='delivering' and stamp last_attempt_at
//      = now(). The status flip is the "claim" -- once a row is 'delivering'
//      it won't match the next claim's WHERE status='pending'. The
//      last_attempt_at stamp doubles as the "stuck since" marker the sweeper
//      uses to recover rows from a worker that crashed mid-delivery.
//
// The outer SELECT joins events + subscriptions so the worker gets the
// payload, URL, and secret in the same round-trip -- no N+1 follow-up queries.
//
// Why a CTE and not a plain UPDATE ... RETURNING? Because RETURNING can only
// return columns of the updated table (deliveries). To also pull event.payload
// and subscription.url/secret we run the UPDATE inside a CTE and JOIN its
// RETURNING output to the related tables in the outer SELECT.
// -----------------------------------------------------------------------------

/**
 * Atomically claim up to `limit` due, pending deliveries: flip them to
 * 'delivering' and return everything needed to attempt them.
 *
 * Safe to run from multiple workers concurrently -- SKIP LOCKED guarantees
 * disjoint claim sets with no blocking.
 */
export async function claimDuePending(limit: number): Promise<ClaimedDelivery[]> {
  const sql = getSql();
  const rows = await sql<DbClaimedDelivery[]>`
    WITH due AS (
      SELECT id
      FROM deliveries
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ),
    claimed AS (
      UPDATE deliveries d
      SET status = 'delivering', last_attempt_at = now()
      FROM due
      WHERE d.id = due.id
      RETURNING d.id, d.event_id, d.subscription_id, d.attempt_count, d.max_attempts
    )
    SELECT
      c.id, c.event_id, c.subscription_id, c.attempt_count, c.max_attempts,
      e.event_type, e.payload,
      s.url, s.secret, s.enabled, s.deleted_at
    FROM claimed c
    JOIN events e        ON e.id = c.event_id
    JOIN subscriptions s ON s.id = c.subscription_id
    ORDER BY c.id ASC
  `;
  return rows.map(toClaimedDelivery);
}

// -----------------------------------------------------------------------------
// Fan-out write
// -----------------------------------------------------------------------------

/**
 * Bulk-insert one delivery row per subscription, all in a single query.
 * Used at event-ingest time: a matched event with N subscribers turns into
 * N delivery rows in `status='pending'`, ready for the worker.
 *
 * Each row is created with column defaults from the schema:
 *   - status          = 'pending'
 *   - attempt_count   = 0
 *   - max_attempts    = 5
 *   - next_attempt_at = now()
 *   - last_attempt_at = NULL
 *   - created_at      = now()
 *
 * One round-trip regardless of how many subscribers matched, vs N round-trips
 * for a per-row loop. At fan-out time this is the difference between "ingest
 * is O(1) network calls" and "ingest is O(N)".
 *
 * Returns the count of rows actually inserted.
 */
export async function insertPendingDeliveries(
  eventId: string,
  subscriptionIds: string[],
  tx?: Sql
): Promise<number> {
  // Bulk-insert syntax requires at least one row. Short-circuit when nobody
  // matched so we don't ship invalid SQL.
  if (subscriptionIds.length === 0) return 0;

  // tx lets the caller bundle this insert with a sibling event-insert into
  // a single transaction (see api/events). When omitted, runs as a
  // standalone statement on the shared client.
  const sql = tx ?? getSql();
  const rows = subscriptionIds.map((subscriptionId) => ({
    event_id: eventId,
    subscription_id: subscriptionId,
  }));

  // postgres.js expands `sql(rows, 'col1', 'col2')` into:
  //   INSERT INTO deliveries ("event_id", "subscription_id")
  //   VALUES ($1, $2), ($3, $4), ...
  // Listing the columns explicitly (vs letting it infer from object keys)
  // protects against typos and makes the SQL self-documenting.
  const result = await sql`
    INSERT INTO deliveries ${sql(rows, 'event_id', 'subscription_id')}
  `;
  return result.count;
}

// -----------------------------------------------------------------------------
// Crash recovery -- the stuck-delivery sweeper
//
// A delivery is flipped to 'delivering' at claim time, then the worker makes
// a slow (up to 10s) HTTP call OUTSIDE any transaction. If the worker crashes,
// times out at the platform level, or is killed mid-call, the row is stranded
// in 'delivering' forever -- it no longer matches the 'pending' claim query,
// so nothing ever retries it.
//
// The sweeper reclaims those rows. Any row that has been 'delivering' longer
// than `staleAfterSeconds` (measured by last_attempt_at, which we stamp at
// claim time) is reset to 'pending' with next_attempt_at=now(), making it
// immediately eligible for the next claim.
//
// The threshold must be comfortably larger than the delivery timeout (10s) so
// we never reset a row that's legitimately still being delivered. The worker
// passes 300s (5 minutes) -- 30x the timeout, leaving a wide safety margin.
//
// Running this BEFORE the claim each tick means a crashed delivery is
// recovered on the first cron run after the threshold elapses.
// -----------------------------------------------------------------------------

/**
 * Reset deliveries stuck in 'delivering' for longer than `staleAfterSeconds`
 * back to 'pending', so the next claim retries them. Returns how many rows
 * were recovered.
 *
 * Note: attempt_count is NOT incremented here -- the stuck attempt may or may
 * not have actually reached the receiver, and there is no delivery_attempts
 * row for it (the worker crashed before recording one). Treating it as "never
 * happened" is the safe, at-least-once choice: we would rather re-deliver than
 * silently drop.
 */
export async function resetStuckDeliveries(staleAfterSeconds: number): Promise<number> {
  const sql = getSql();
  const result = await sql`
    UPDATE deliveries
    SET status = 'pending', next_attempt_at = now()
    WHERE status = 'delivering'
      AND last_attempt_at < now() - make_interval(secs => ${staleAfterSeconds})
  `;
  return result.count;
}

// -----------------------------------------------------------------------------
// Result recording -- the post-attempt half of the worker loop
// -----------------------------------------------------------------------------

/**
 * Append one row to the delivery_attempts log. Append-only: every HTTP attempt
 * gets a row, win or lose, so the full delivery history is reconstructable.
 *
 * `attemptNum` is 1-based -- the first attempt is attempt 1. The worker passes
 * (priorAttemptCount + 1).
 */
export async function recordAttempt(
  deliveryId: string,
  attemptNum: number,
  result: DeliveryAttemptResult,
  tx?: Sql
): Promise<void> {
  const sql = tx ?? getSql();
  await sql`
    INSERT INTO delivery_attempts
      (delivery_id, attempt_num, http_status, response_body, latency_ms, error)
    VALUES (
      ${deliveryId},
      ${attemptNum},
      ${result.httpStatus},
      ${result.responseBody},
      ${result.latencyMs},
      ${result.error}
    )
  `;
}

export interface FinalizeResult {
  /** The status the delivery landed in: delivered | pending (retry) | failed. */
  status: DeliveryStatus;
  /** True when the delivery moved to a terminal state (delivered or failed). */
  terminal: boolean;
}

/**
 * Terminally fail a claimed delivery WITHOUT scheduling a retry. Used by the
 * worker when the destination is no longer a valid target -- the subscription
 * was disabled or soft-deleted between fan-out and delivery. Retrying would
 * never succeed (the subscription is still disabled), so we go straight to
 * 'failed' and record why via a companion recordAttempt call.
 *
 * Same status='delivering' compare-and-set guard as finalizeDelivery.
 */
export async function failClaimedDelivery(
  deliveryId: string,
  newAttemptCount: number,
  tx?: Sql
): Promise<void> {
  const sql = tx ?? getSql();
  await sql`
    UPDATE deliveries
    SET status = 'failed', attempt_count = ${newAttemptCount}, next_attempt_at = NULL
    WHERE id = ${deliveryId} AND status = 'delivering'
  `;
}

/**
 * Transition a claimed ('delivering') delivery based on the attempt outcome.
 *
 *   success            -> status='delivered'                       (terminal)
 *   fail, attempts<max -> status='pending', next_attempt_at=backoff (retry)
 *   fail, attempts>=max-> status='failed'                          (terminal)
 *
 * `priorAttemptCount` is the attempt_count value the row had when claimed.
 * We compute newCount = priorAttemptCount + 1 and persist it. The retry
 * schedule is keyed on newCount so the first retry waits 60s, etc. (see
 * lib/backoff.ts).
 *
 * The WHERE clause pins status='delivering' so this only ever transitions a
 * row WE claimed -- if a sweeper already reset it to 'pending' (because we
 * were too slow), this UPDATE matches nothing and we don't clobber the reset.
 */
export async function finalizeDelivery(
  deliveryId: string,
  priorAttemptCount: number,
  maxAttempts: number,
  success: boolean,
  tx?: Sql
): Promise<FinalizeResult> {
  const sql = tx ?? getSql();
  const newCount = priorAttemptCount + 1;

  if (success) {
    await sql`
      UPDATE deliveries
      SET status = 'delivered', attempt_count = ${newCount}, next_attempt_at = NULL
      WHERE id = ${deliveryId} AND status = 'delivering'
    `;
    return { status: 'delivered', terminal: true };
  }

  // Failure path. Exhausted -> terminal 'failed'; otherwise schedule a retry.
  if (newCount >= maxAttempts) {
    await sql`
      UPDATE deliveries
      SET status = 'failed', attempt_count = ${newCount}, next_attempt_at = NULL
      WHERE id = ${deliveryId} AND status = 'delivering'
    `;
    return { status: 'failed', terminal: true };
  }

  const retryAt = nextAttemptAt(newCount);
  await sql`
    UPDATE deliveries
    SET status = 'pending', attempt_count = ${newCount}, next_attempt_at = ${retryAt}
    WHERE id = ${deliveryId} AND status = 'delivering'
  `;
  return { status: 'pending', terminal: false };
}

// -----------------------------------------------------------------------------
// Read side -- the public deliveries API (GET /api/deliveries[/:id])
//
// These return the PUBLIC Delivery / DeliveryAttempt shapes: no secret, no
// event payload. They are safe to expose over HTTP.
// -----------------------------------------------------------------------------

interface DbDelivery {
  id: string;
  event_id: string;
  subscription_id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: Date | string | null;
  last_attempt_at: Date | string | null;
  created_at: Date | string;
}

function toDelivery(r: DbDelivery): Delivery {
  return {
    id: r.id,
    eventId: r.event_id,
    subscriptionId: r.subscription_id,
    status: r.status as DeliveryStatus,
    attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts,
    nextAttemptAt: r.next_attempt_at === null ? null : new Date(r.next_attempt_at).toISOString(),
    lastAttemptAt: r.last_attempt_at === null ? null : new Date(r.last_attempt_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

interface DbDeliveryAttempt {
  id: string;
  delivery_id: string;
  attempt_num: number;
  http_status: number | null;
  response_body: string | null;
  latency_ms: number | null;
  error: string | null;
  attempted_at: Date | string;
}

function toDeliveryAttempt(r: DbDeliveryAttempt): DeliveryAttempt {
  return {
    id: r.id,
    deliveryId: r.delivery_id,
    attemptNum: r.attempt_num,
    httpStatus: r.http_status,
    responseBody: r.response_body,
    latencyMs: r.latency_ms,
    error: r.error,
    attemptedAt: new Date(r.attempted_at).toISOString(),
  };
}

/**
 * List deliveries matching an optional set of filters, newest first.
 *
 * All three filters (eventId, subscriptionId, status) are optional and
 * AND-combined. With no filters, returns the most recent `limit` deliveries.
 *
 * The dynamic WHERE is built by composing parameterised sql`` fragments --
 * every value is still a bound parameter, never string-interpolated, so this
 * is injection-safe despite being "dynamic".
 */
export async function queryDeliveries(
  q: DeliveryQuery,
  limit = 100
): Promise<Delivery[]> {
  const sql = getSql();

  const conds = [];
  if (q.eventId) conds.push(sql`event_id = ${q.eventId}`);
  if (q.subscriptionId) conds.push(sql`subscription_id = ${q.subscriptionId}`);
  if (q.status) conds.push(sql`status = ${q.status}`);

  // Fold the fragments into "a AND b AND c", or an empty fragment if no
  // filters were supplied (postgres.js treats an empty sql`` as no-op text).
  const where =
    conds.length > 0
      ? conds.reduce((acc, cur) => sql`${acc} AND ${cur}`)
      : sql``;
  const whereClause = conds.length > 0 ? sql`WHERE ${where}` : sql``;

  const rows = await sql<DbDelivery[]>`
    SELECT id, event_id, subscription_id, status, attempt_count, max_attempts,
           next_attempt_at, last_attempt_at, created_at
    FROM deliveries
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map(toDelivery);
}

/**
 * Fetch a single delivery by id with its full attempt history nested in,
 * ordered oldest attempt first. Returns null if the delivery doesn't exist.
 *
 * Two queries, not a join: a join would repeat every delivery column once per
 * attempt row, and we'd de-dupe in app code anyway. Two clean queries are
 * simpler and the second is a single indexed lookup on delivery_id.
 */
export async function getDeliveryWithAttempts(
  id: string
): Promise<DeliveryWithAttempts | null> {
  const sql = getSql();

  const deliveryRows = await sql<DbDelivery[]>`
    SELECT id, event_id, subscription_id, status, attempt_count, max_attempts,
           next_attempt_at, last_attempt_at, created_at
    FROM deliveries
    WHERE id = ${id}
    LIMIT 1
  `;
  if (deliveryRows.length === 0) return null;

  const attemptRows = await sql<DbDeliveryAttempt[]>`
    SELECT id, delivery_id, attempt_num, http_status, response_body,
           latency_ms, error, attempted_at
    FROM delivery_attempts
    WHERE delivery_id = ${id}
    ORDER BY attempt_num ASC
  `;

  return {
    ...toDelivery(deliveryRows[0]!),
    attempts: attemptRows.map(toDeliveryAttempt),
  };
}
