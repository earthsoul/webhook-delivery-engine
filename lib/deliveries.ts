import { getSql, type Sql } from './db.js';

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
