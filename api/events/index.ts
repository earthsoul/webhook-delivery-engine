import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSql } from '../../lib/db.js';
import { insertEventIdempotent } from '../../lib/events.js';
import { findMatchingSubscriptions } from '../../lib/subscriptions.js';
import { insertPendingDeliveries } from '../../lib/deliveries.js';
import type { IngestEventRequest } from '../../lib/types.js';

const MAX_EVENT_TYPE_LENGTH = 100;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
// JSONB rows above ~1MB risk slow inserts and TOAST overhead. 256 KB is
// generous for typical event payloads (an order, a customer record) while
// keeping abuse contained.
const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * Runtime validator for POST body. Same "parse, don't validate" pattern as
 * /api/subscriptions: returns the typed value on success, structured error
 * on failure.
 */
function parseIngestInput(body: unknown):
  | { ok: true; value: IngestEventRequest; payloadBytes: number }
  | { ok: false; error: string; field?: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.eventType !== 'string' || b.eventType.length === 0) {
    return { ok: false, error: 'eventType must be a non-empty string', field: 'eventType' };
  }
  if (b.eventType.length > MAX_EVENT_TYPE_LENGTH) {
    return {
      ok: false,
      error: `eventType must be at most ${MAX_EVENT_TYPE_LENGTH} characters`,
      field: 'eventType',
    };
  }

  if (typeof b.payload !== 'object' || b.payload === null || Array.isArray(b.payload)) {
    return {
      ok: false,
      error: 'payload must be a JSON object (not an array, string, or number)',
      field: 'payload',
    };
  }

  // Approximate payload size cap. JSON.stringify gives the wire-size and
  // is what we'll actually send to subscribers, so this is the meaningful
  // measurement. We do this once, here, so the value can be reused on the
  // happy path without a re-stringify.
  const payloadBytes = Buffer.byteLength(JSON.stringify(b.payload), 'utf8');
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      error: `payload exceeds the ${MAX_PAYLOAD_BYTES} byte cap (got ${payloadBytes} bytes)`,
      field: 'payload',
    };
  }

  let idempotencyKey: string | undefined;
  if (b.idempotencyKey !== undefined && b.idempotencyKey !== null) {
    if (typeof b.idempotencyKey !== 'string' || b.idempotencyKey.length === 0) {
      return {
        ok: false,
        error: 'idempotencyKey must be a non-empty string when provided',
        field: 'idempotencyKey',
      };
    }
    if (b.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return {
        ok: false,
        error: `idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
        field: 'idempotencyKey',
      };
    }
    idempotencyKey = b.idempotencyKey;
  }

  return {
    ok: true,
    value: {
      eventType: b.eventType,
      payload: b.payload as Record<string, unknown>,
      idempotencyKey,
    },
    payloadBytes,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const parsed = parseIngestInput(req.body);
  if (!parsed.ok) {
    return res
      .status(400)
      .json({ error: 'invalid_input', message: parsed.error, field: parsed.field });
  }

  try {
    // Atomic ingestion. Both writes either commit together or neither does:
    //
    //   1. INSERT into events (with idempotent ON CONFLICT semantics).
    //   2. If freshly inserted, fan out: find matching subscriptions and
    //      bulk-insert one 'pending' delivery row per subscription.
    //
    // Wrapping in sql.begin closes the partial-failure window where the
    // event would exist but its deliveries wouldn't (and a retry with the
    // same idempotencyKey would never re-create them).
    //
    // On idempotent replay (event already exists), we deliberately do NOT
    // re-fan-out -- the original ingest's deliveries are the canonical set.
    // Re-running findMatching here would create duplicate deliveries if the
    // subscription set changed between the original call and the replay.
    const sql = getSql();
    const result = await sql.begin(async (tx) => {
      const ev = await insertEventIdempotent(parsed.value, tx);

      if (!ev.isNew) {
        return { event: ev.event, deliveriesScheduled: 0, replayed: true };
      }

      const matching = await findMatchingSubscriptions(ev.event.eventType, tx);
      const ids = matching.map((s) => s.id);
      const inserted = await insertPendingDeliveries(ev.event.id, ids, tx);

      return { event: ev.event, deliveriesScheduled: inserted, replayed: false };
    });

    if (result.replayed) {
      // 200 with the original event. The contract: clients can retry safely
      // -- the second response is identical to the first (minus the 202).
      return res.status(200).json({
        eventId: result.event.id,
        deliveriesScheduled: 0,
        message: 'duplicate idempotency key; returning original event',
        duplicate: true,
      });
    }

    // 202 Accepted: ingestion complete, delivery is asynchronous.
    return res.status(202).json({
      eventId: result.event.id,
      deliveriesScheduled: result.deliveriesScheduled,
      message: 'event accepted',
    });
  } catch (err) {
    console.error('POST /api/events failed', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
