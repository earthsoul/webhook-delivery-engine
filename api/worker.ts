import type { VercelRequest, VercelResponse } from '@vercel/node';
import { timingSafeEqual } from 'node:crypto';
import { getSql } from '../lib/db.js';
import {
  claimDuePending,
  failClaimedDelivery,
  finalizeDelivery,
  recordAttempt,
  resetStuckDeliveries,
  type ClaimedDelivery,
} from '../lib/deliveries.js';
import { deliverWebhook, type DeliveryAttemptResult } from '../lib/deliver.js';
import type { DeliveryStatus, WorkerSummary } from '../lib/types.js';

// How many due deliveries to pull per run. The cron fires every minute, so
// this is the per-minute throughput ceiling. Kept modest so a run fits well
// inside the Vercel function execution budget even if many receivers are slow.
const BATCH_SIZE = 50;

// A row 'delivering' longer than this is treated as abandoned (worker crashed
// mid-call) and reset to pending. 30x the 10s delivery timeout -- see
// resetStuckDeliveries.
const STALE_AFTER_SECONDS = 300;

/**
 * Constant-time bearer-token check. Protects the worker from being driven by
 * random internet traffic -- only callers presenting the WORKER_SECRET (Vercel
 * Cron, configured with the same value) get through.
 *
 * timingSafeEqual (not ===) so an attacker can't recover the secret byte by
 * byte via response-timing measurement. Length is checked first because
 * timingSafeEqual throws on length mismatch -- and that check is itself
 * constant-cost (it doesn't depend on the secret's content).
 */
function isAuthorized(req: VercelRequest): boolean {
  const expected = process.env.WORKER_SECRET;
  if (!expected) {
    // Fail closed: if the secret isn't configured, nobody is authorized.
    console.error('WORKER_SECRET is not set; refusing all worker calls');
    return false;
  }

  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;

  const presented = header.slice('Bearer '.length);
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Attempt a single claimed delivery and persist the outcome. Returns the
 * terminal/next status so the caller can tally a summary.
 *
 * The HTTP call happens OUTSIDE any transaction (it's slow, up to 10s, and we
 * must not hold a DB connection open across it). Only the two quick writes --
 * the attempt log and the status transition -- run inside a short transaction,
 * so the log row and the state change commit together or not at all.
 */
async function processDelivery(d: ClaimedDelivery): Promise<DeliveryStatus> {
  const sql = getSql();
  const attemptNum = d.attemptCount + 1;

  // Destination no longer valid: subscription was disabled or soft-deleted
  // between fan-out and now. Don't attempt HTTP -- record why and fail
  // terminally (a retry can't fix a disabled subscription).
  if (!d.enabled || d.deletedAt !== null) {
    const reason = d.deletedAt !== null ? 'subscription deleted' : 'subscription disabled';
    const synthetic: DeliveryAttemptResult = {
      success: false,
      httpStatus: null,
      responseBody: null,
      latencyMs: 0,
      error: reason,
    };
    await sql.begin(async (tx) => {
      await recordAttempt(d.id, attemptNum, synthetic, tx);
      await failClaimedDelivery(d.id, attemptNum, tx);
    });
    return 'failed';
  }

  // Slow part, no transaction held.
  const result = await deliverWebhook({
    url: d.url,
    payload: d.payload,
    secret: d.secret,
    deliveryId: d.id,
  });

  // Quick writes, atomic together.
  const fin = await sql.begin(async (tx) => {
    await recordAttempt(d.id, attemptNum, result, tx);
    return finalizeDelivery(d.id, d.attemptCount, d.maxAttempts, result.success, tx);
  });

  return fin.status;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    // 1. Recover anything stranded by a previous crashed run, BEFORE claiming,
    //    so a stuck delivery becomes eligible again this same tick.
    const swept = await resetStuckDeliveries(STALE_AFTER_SECONDS);

    // 2. Atomically claim a batch of due deliveries (flips them to
    //    'delivering'; safe against concurrent workers via SKIP LOCKED).
    const claimed = await claimDuePending(BATCH_SIZE);

    // 3. Process them concurrently. Each HTTP call runs outside any
    //    transaction; the per-delivery writes are short and independent, so
    //    parallelism here is bounded by the connection pool, not by holding
    //    locks. Promise.allSettled so one thrown error can't sink the batch.
    const outcomes = await Promise.allSettled(claimed.map(processDelivery));

    const summary: WorkerSummary = {
      swept,
      processed: claimed.length,
      delivered: 0,
      retrying: 0,
      failed: 0,
    };
    for (const o of outcomes) {
      if (o.status === 'rejected') {
        // An unexpected throw (not a normal delivery failure -- those are
        // captured as values). The row stays 'delivering' and the sweeper
        // will recover it. Count it as failed for this run's summary.
        console.error('worker: processDelivery threw', o.reason);
        summary.failed += 1;
        continue;
      }
      if (o.value === 'delivered') summary.delivered += 1;
      else if (o.value === 'pending') summary.retrying += 1;
      else if (o.value === 'failed') summary.failed += 1;
    }

    // Vercel surfaces this body in the cron run history -- structured counts
    // give free per-run observability.
    return res.status(200).json(summary);
  } catch (err) {
    console.error('POST /api/worker failed', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
