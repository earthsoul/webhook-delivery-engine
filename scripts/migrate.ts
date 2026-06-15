/**
 * One-shot DB migration. Creates every table, index, and CHECK constraint the
 * webhook engine needs. Safe to re-run -- every statement uses IF NOT EXISTS.
 *
 *   npm run migrate
 *
 * Reads POSTGRES_URL from .env via tsx's --env-file flag.
 *
 * For a real production project you'd use a versioned migrations tool
 * (Flyway, Prisma Migrate, etc.) so each schema change becomes its own
 * timestamped file. For a portfolio project this single script keeps the
 * setup story to one command.
 */
import postgres from 'postgres';

async function main() {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    console.error('POSTGRES_URL is not set. Fill it into .env and re-run.');
    process.exit(1);
  }

  // prepare: false because the Supabase pooler runs in transaction mode and
  // does not support prepared statements (see lib/db.ts for the full story).
  const sql = postgres(url, { prepare: false });

  try {
    // -------------------------------------------------------------------------
    // subscriptions -- destination URL + which event types it cares about.
    // deleted_at is a soft-delete marker: we never hard-delete because that
    // would orphan delivery rows pointing at the FK. Filtering deleted_at IS
    // NULL in queries gives us a "tombstoned" row without breaking history.
    // -------------------------------------------------------------------------
    console.log('Creating table: subscriptions ...');
    await sql`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        url         TEXT NOT NULL,
        event_types TEXT[] NOT NULL,
        secret      TEXT NOT NULL,
        enabled     BOOLEAN NOT NULL DEFAULT true,
        deleted_at  TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    // GIN index on event_types -- the fan-out query is
    //   WHERE event_types @> ARRAY[$1]
    // which only an array-aware index can serve efficiently.
    console.log('Creating index: idx_subscriptions_event_types (GIN) ...');
    await sql`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_event_types
        ON subscriptions USING GIN (event_types)
        WHERE deleted_at IS NULL AND enabled = true
    `;

    // -------------------------------------------------------------------------
    // events -- the durable record of every accepted ingestion. payload is
    // JSONB so we can store arbitrary client-supplied JSON without a schema.
    // -------------------------------------------------------------------------
    console.log('Creating table: events ...');
    await sql`
      CREATE TABLE IF NOT EXISTS events (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key TEXT,
        event_type      TEXT NOT NULL,
        payload         JSONB NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    // Partial UNIQUE index: enforce idempotency only when a key is supplied.
    // A regular UNIQUE on a nullable column would also allow multiple NULLs in
    // Postgres, but a partial index makes the intent explicit and is smaller
    // (it skips every NULL row entirely).
    console.log('Creating index: idx_events_idempotency (partial UNIQUE) ...');
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency
        ON events (idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `;

    // -------------------------------------------------------------------------
    // deliveries -- one row per (event x matching subscription) at fan-out time.
    // The status column doubles as a row-level lock: the worker uses
    //   UPDATE ... WHERE status='pending' RETURNING ...
    // to atomically claim a row and flip it to 'delivering'.
    //
    // The CHECK on status is defence in depth -- the application only writes
    // values from the TS DeliveryStatus union, but a bad migration or manual
    // SQL edit shouldn't be able to break the invariant.
    //
    // ON DELETE RESTRICT on subscription_id is explicit: we never want a
    // subscription delete to cascade and lose delivery history. We soft-delete
    // subscriptions instead (deleted_at).
    // -------------------------------------------------------------------------
    console.log('Creating table: deliveries ...');
    await sql`
      CREATE TABLE IF NOT EXISTS deliveries (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id         UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
        subscription_id  UUID NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
        status           TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','delivering','delivered','failed')),
        attempt_count    INTEGER NOT NULL DEFAULT 0,
        max_attempts     INTEGER NOT NULL DEFAULT 5,
        -- Nullable on purpose: a terminal delivery (delivered/failed) has no
        -- "next attempt", so finalizeDelivery sets this to NULL. Pending rows
        -- always carry a real timestamp (DEFAULT now() on insert, or an
        -- explicit retry time), which is what the idx_deliveries_due partial
        -- index covers. Making this NOT NULL would reject every terminal
        -- transition with a 23502 not-null violation.
        next_attempt_at  TIMESTAMPTZ DEFAULT now(),
        last_attempt_at  TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    // The hot worker query is
    //   WHERE status='pending' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 50
    // A partial index keyed on next_attempt_at and filtered to status='pending'
    // is the smallest possible index that fully serves it.
    console.log('Creating index: idx_deliveries_due (partial) ...');
    await sql`
      CREATE INDEX IF NOT EXISTS idx_deliveries_due
        ON deliveries (next_attempt_at)
        WHERE status = 'pending'
    `;

    // The stuck-row sweeper query is
    //   WHERE status='delivering' AND last_attempt_at < now() - interval '5 minutes'
    // Same shape, different status -- another partial index, even smaller.
    console.log('Creating index: idx_deliveries_stuck (partial) ...');
    await sql`
      CREATE INDEX IF NOT EXISTS idx_deliveries_stuck
        ON deliveries (last_attempt_at)
        WHERE status = 'delivering'
    `;

    // GET /api/deliveries supports filtering by eventId or subscriptionId.
    // Plain btree on each FK column covers those scans.
    console.log('Creating index: idx_deliveries_event ...');
    await sql`CREATE INDEX IF NOT EXISTS idx_deliveries_event ON deliveries (event_id)`;
    console.log('Creating index: idx_deliveries_subscription ...');
    await sql`CREATE INDEX IF NOT EXISTS idx_deliveries_subscription ON deliveries (subscription_id)`;

    // -------------------------------------------------------------------------
    // delivery_attempts -- append-only log of every individual HTTP attempt.
    // One delivery may produce N attempts (1..max_attempts). response_body is
    // truncated to ~2KB at the application layer before insert -- the column
    // itself is unconstrained TEXT for flexibility.
    // -------------------------------------------------------------------------
    console.log('Creating table: delivery_attempts ...');
    await sql`
      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        delivery_id   UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
        attempt_num   INTEGER NOT NULL,
        http_status   INTEGER,
        response_body TEXT,
        latency_ms    INTEGER,
        error         TEXT,
        attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    console.log('Creating index: idx_delivery_attempts_delivery ...');
    await sql`
      CREATE INDEX IF NOT EXISTS idx_delivery_attempts_delivery
        ON delivery_attempts (delivery_id)
    `;

    console.log('\nMigration complete.');
  } finally {
    // Close the pool so the process exits instead of hanging.
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
