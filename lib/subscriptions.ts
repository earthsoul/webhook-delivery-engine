import { randomBytes } from 'node:crypto';
import { getSql, type Sql } from './db.js';
import type {
  CreateSubscriptionInput,
  CreateSubscriptionResult,
  Subscription,
  UpdateSubscriptionInput,
} from './types.js';

// -----------------------------------------------------------------------------
// Row types -- snake_case to match Postgres exactly. Kept private to this
// module so snake_case never leaks into the rest of the app.
//
// Two shapes intentionally:
//   - DbSubscriptionPublic: the columns we select for list/get -- no secret.
//   - DbSubscriptionWithSecret: adds the secret column for the create path.
//
// Selecting only what we need (no SELECT *) means a buggy mapper can't
// accidentally leak the secret in a list/get response.
// -----------------------------------------------------------------------------
interface DbSubscriptionPublic {
  id: string;
  url: string;
  event_types: string[];
  enabled: boolean;
  created_at: Date | string;
}

interface DbSubscriptionWithSecret extends DbSubscriptionPublic {
  secret: string;
}

/**
 * Map a public-columns row to the camelCase domain type.
 * Done by hand (not auto-mapped) so the column-to-field contract stays visible.
 */
function toSubscription(r: DbSubscriptionPublic): Subscription {
  return {
    id: r.id,
    url: r.url,
    eventTypes: r.event_types,
    enabled: r.enabled,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Secret generation
// -----------------------------------------------------------------------------

/**
 * Generate a fresh HMAC signing secret for a new subscription.
 *
 * 32 bytes from crypto.randomBytes -> 64 hex chars of entropy. The whsec_
 * prefix mirrors Stripe's convention -- a recognisable shape that lets a
 * future rotation/revocation flow detect "this looks like a webhook secret"
 * (vs an API key, vs a bearer token, etc.) without parsing it.
 */
function generateSecret(): string {
  return 'whsec_' + randomBytes(32).toString('hex');
}

// -----------------------------------------------------------------------------
// Query functions
// -----------------------------------------------------------------------------

/**
 * List every live (non-soft-deleted) subscription, newest first.
 *
 * The `secret` column is intentionally NOT selected -- it must never appear in
 * a list response. The TS return type (Subscription, no secret field) is the
 * compile-time half of the same guarantee.
 */
export async function listSubscriptions(): Promise<Subscription[]> {
  const sql = getSql();
  const rows = await sql<DbSubscriptionPublic[]>`
    SELECT id, url, event_types, enabled, created_at
    FROM subscriptions
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC
  `;
  return rows.map(toSubscription);
}

/**
 * Look up a single live subscription by id. Returns null if not found OR if
 * the row is soft-deleted -- both look like "404 Not Found" to a caller, so
 * the layer above doesn't need to distinguish.
 *
 * As with listSubscriptions, the secret column is not selected.
 */
export async function getSubscription(id: string): Promise<Subscription | null> {
  const sql = getSql();
  const rows = await sql<DbSubscriptionPublic[]>`
    SELECT id, url, event_types, enabled, created_at
    FROM subscriptions
    WHERE id = ${id} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return toSubscription(rows[0]!);
}

/**
 * Insert a new subscription, generating a fresh signing secret server-side.
 *
 * The secret is returned ONCE on creation and never again -- the caller must
 * store it. This is the only function in the module that returns the secret
 * column; every other path keeps it isolated to the database row.
 *
 * No validation here -- the API handler (api/subscriptions) is responsible
 * for rejecting bad URLs, empty event_types, etc. before we ever reach SQL.
 */
export async function createSubscription(
  input: CreateSubscriptionInput
): Promise<CreateSubscriptionResult> {
  const sql = getSql();
  const secret = generateSecret();

  const rows = await sql<DbSubscriptionWithSecret[]>`
    INSERT INTO subscriptions (url, event_types, secret)
    VALUES (${input.url}, ${input.eventTypes}, ${secret})
    RETURNING id, url, event_types, secret, enabled, created_at
  `;
  const row = rows[0]!;
  return { ...toSubscription(row), secret: row.secret };
}

/**
 * Apply a partial update to a subscription. Only fields that are explicitly
 * present in `input` change; everything else is preserved.
 *
 * Returns the updated row, or null if no live subscription exists with that id
 * (either the id is wrong or the row is already soft-deleted -- both are 404
 * to the API layer).
 *
 * Implementation note: we use COALESCE(${maybe}, column) per field instead of
 * a dynamic SET clause. The driver substitutes NULL when a JS field is
 * undefined, and COALESCE(NULL, existing) keeps the existing value. This is
 * branchless SQL and reads more clearly than building a query string. It is
 * safe here because every settable column is NOT NULL -- there is no legitimate
 * "set this to NULL" case to worry about.
 */
export async function updateSubscription(
  id: string,
  input: UpdateSubscriptionInput
): Promise<Subscription | null> {
  // Empty PATCH -> nothing to write. Read-through so the caller still gets
  // the current row (or null) without touching disk.
  if (
    input.url === undefined &&
    input.eventTypes === undefined &&
    input.enabled === undefined
  ) {
    return getSubscription(id);
  }

  const sql = getSql();
  const rows = await sql<DbSubscriptionPublic[]>`
    UPDATE subscriptions
    SET
      url         = COALESCE(${input.url ?? null}, url),
      event_types = COALESCE(${input.eventTypes ?? null}, event_types),
      enabled     = COALESCE(${input.enabled ?? null}, enabled)
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING id, url, event_types, enabled, created_at
  `;
  if (rows.length === 0) return null;
  return toSubscription(rows[0]!);
}

/**
 * Return every live, enabled subscription whose event_types includes the
 * given eventType. Used at event-ingestion time to fan out -- one delivery
 * row per matching subscription.
 *
 * The query is shaped to fit the partial GIN index defined in
 * scripts/migrate.ts (`idx_subscriptions_event_types`):
 *
 *   - The WHERE predicate matches the partial-index condition exactly
 *     (deleted_at IS NULL AND enabled = true), so the planner uses the
 *     partial GIN instead of scanning the full table.
 *   - `event_types @> ${[eventType]}` is array-containment -- GIN's
 *     reason for existing. A regular btree on TEXT[] would be useless;
 *     a sequential scan would scale linearly with subscription count.
 *
 * The `secret` column is intentionally not selected (returns the public
 * Subscription type). Workers fetch the secret only when they actually
 * claim a delivery for a subscription.
 */
export async function findMatchingSubscriptions(
  eventType: string,
  tx?: Sql
): Promise<Subscription[]> {
  // tx lets the caller scope this lookup to the same transaction as the
  // delivery inserts that follow, so the SELECT and INSERTs see one
  // consistent snapshot. Optional -- standalone calls use the shared client.
  const sql = tx ?? getSql();
  const rows = await sql<DbSubscriptionPublic[]>`
    SELECT id, url, event_types, enabled, created_at
    FROM subscriptions
    WHERE event_types @> ${[eventType]}
      AND deleted_at IS NULL
      AND enabled = true
    ORDER BY created_at ASC
  `;
  return rows.map(toSubscription);
}

/**
 * Soft-delete a subscription by stamping deleted_at = now().
 *
 * Returns true if a live row was deleted, false if no live row matched the id
 * (already deleted, or never existed). The WHERE deleted_at IS NULL clause
 * makes the operation idempotent at the SQL layer -- a second call returns
 * false instead of bumping the timestamp.
 *
 * We deliberately never DELETE the row. The deliveries table has FK references
 * to subscriptions; cascading those would destroy the audit trail, restricting
 * them would block deletion outright. Soft-delete sidesteps both problems and
 * lets us answer "what subscription was this delivery for?" forever.
 */
export async function softDeleteSubscription(id: string): Promise<boolean> {
  const sql = getSql();
  const result = await sql`
    UPDATE subscriptions
    SET deleted_at = now()
    WHERE id = ${id} AND deleted_at IS NULL
  `;
  return result.count > 0;
}
