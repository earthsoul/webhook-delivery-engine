import { getSql, type Sql } from './db.js';

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
