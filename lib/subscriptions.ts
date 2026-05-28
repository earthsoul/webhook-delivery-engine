import { randomBytes } from 'node:crypto';
import { getSql } from './db.js';
import type {
  CreateSubscriptionInput,
  CreateSubscriptionResult,
  Subscription,
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
