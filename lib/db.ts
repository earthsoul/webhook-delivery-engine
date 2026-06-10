import postgres from 'postgres';

/**
 * The shape of a postgres.js client. Re-exported so other modules can declare
 * "I accept either the shared client or a transaction handle" in their
 * signatures without importing `postgres` themselves.
 *
 * Inside `sql.begin(async (tx) => ...)`, `tx` has this same type. That's why
 * one function can run against the shared client OR inside a transaction
 * without changing its body.
 */
export type Sql = ReturnType<typeof postgres>;

// Module-level cache. The first getSql() call constructs the client; every
// subsequent call hands back the same instance. Vercel keeps a function's
// module scope alive across warm invocations, so this also acts as a
// per-instance connection cache.
let _sql: Sql | null = null;

/**
 * Returns a shared Postgres client connected to Supabase via the pooler.
 *
 * Lazy on purpose: importing this module must not require POSTGRES_URL to be
 * set (scripts, tests, and typecheck all import it). The connection is only
 * configured the first time a caller actually wants to talk to the DB.
 */
export function getSql() {
  if (_sql) return _sql;

  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      'Missing POSTGRES_URL. Set it in your .env file or Vercel project settings (use the Supabase pooler URL on port 6543).'
    );
  }

  // Supabase's pooler (PgBouncer) runs in transaction mode and does NOT
  // support prepared statements — without prepare:false we get
  // 'prepared statement "..." does not exist' errors on any reused query.
  // Configure once here; forget about it everywhere else.
  _sql = postgres(url, { prepare: false });
  return _sql;
}
