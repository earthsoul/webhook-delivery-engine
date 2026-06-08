import { getSql } from './db.js';
import type { Event } from './types.js';

// -----------------------------------------------------------------------------
// Row type and mapper. Same shape-mirror pattern as lib/subscriptions.ts:
// snake_case lives only inside this module; everything outside sees Event.
// -----------------------------------------------------------------------------
interface DbEvent {
  id: string;
  idempotency_key: string | null;
  event_type: string;
  // postgres.js parses JSONB into a real JS value before handing it back, so
  // payload arrives as an object/array/etc. -- no JSON.parse here.
  payload: Record<string, unknown>;
  created_at: Date | string;
}

function toEvent(r: DbEvent): Event {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    eventType: r.event_type,
    payload: r.payload,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Insert input and result shapes
// -----------------------------------------------------------------------------

export interface InsertEventInput {
  eventType: string;
  payload: Record<string, unknown>;
  /**
   * Optional client-supplied dedupe key. If present and a previous event was
   * inserted with the same key, no new row is created and the original event
   * is returned with `isNew: false`.
   */
  idempotencyKey?: string | null;
}

export interface InsertEventResult {
  event: Event;
  /** true if a new row was just inserted; false if this was an idempotent replay. */
  isNew: boolean;
}

// -----------------------------------------------------------------------------
// The atomic, race-free idempotent insert.
//
// The classic naive approach -- "SELECT first, then INSERT if missing" -- is
// racy: two parallel requests with the same key both pass the SELECT, both
// try to INSERT, and the second one crashes on the UNIQUE constraint.
//
// The correct approach is ONE statement that does both operations atomically:
//
//   INSERT ... ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
//   DO NOTHING RETURNING ...
//
// Postgres handles the entire "is this key already taken?" check inside the
// INSERT under a row-level lock. After the statement:
//   - rows.length === 1 => we just inserted (this caller is the winner).
//   - rows.length === 0 => somebody else inserted first; we missed.
//
// In the "missed" branch we do a follow-up SELECT to fetch their row so the
// caller still gets back the canonical event (same id, same payload). The
// follow-up cannot race -- the ON CONFLICT proves a row exists.
//
// NULL idempotency keys never conflict (the partial unique index filters
// idempotency_key IS NOT NULL), so events submitted without a key always
// produce a new row -- as the API contract documents.
// -----------------------------------------------------------------------------
export async function insertEventIdempotent(
  input: InsertEventInput
): Promise<InsertEventResult> {
  const sql = getSql();
  const idempKey = input.idempotencyKey ?? null;

  // postgres.js can serialise plain objects as JSONB when the column type is
  // JSONB, but being explicit (JSON.stringify + ::jsonb cast) sidesteps any
  // ambiguity around how the driver detects "this object should be a row" vs
  // "this object should be a JSONB value". Unambiguous here is cheap.
  const payloadJson = JSON.stringify(input.payload);

  const inserted = await sql<DbEvent[]>`
    INSERT INTO events (idempotency_key, event_type, payload)
    VALUES (${idempKey}, ${input.eventType}, ${payloadJson}::jsonb)
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
    DO NOTHING
    RETURNING id, idempotency_key, event_type, payload, created_at
  `;

  if (inserted.length > 0) {
    return { event: toEvent(inserted[0]!), isNew: true };
  }

  // Conflict path. The ON CONFLICT could only have triggered against a
  // non-NULL key, so idempKey is guaranteed non-NULL here.
  const existing = await sql<DbEvent[]>`
    SELECT id, idempotency_key, event_type, payload, created_at
    FROM events
    WHERE idempotency_key = ${idempKey}
    LIMIT 1
  `;
  if (existing.length === 0) {
    // Should be impossible: the conflict proves a row exists. If we ever
    // hit this it points to a serious schema or driver bug, not user error.
    throw new Error('Idempotency conflict reported but no matching event found');
  }
  return { event: toEvent(existing[0]!), isNew: false };
}
