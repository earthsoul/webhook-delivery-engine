/**
 * End-to-end smoke test for the whole delivery engine, in one process.
 *
 *   npx tsx --env-file=.env scripts/_smoke/e2e.ts
 *
 * Requires a migrated database (npm run migrate) and POSTGRES_URL +
 * WORKER_SECRET in .env. It starts the real API handlers and a fake
 * subscriber in-process, then drives the complete lifecycle and asserts the
 * outcomes:
 *
 *   1. Ingest an event           -> 202, fans out to 2 deliveries
 *   2. Re-ingest (same key)      -> 200 duplicate, no new deliveries
 *   3. Worker auth, wrong token  -> 401
 *   4. Worker run #1             -> happy delivery delivered, flaky retries
 *   5. Worker runs #2 and #3     -> flaky succeeds on its 3rd attempt
 *   6. Inspect the flaky delivery-> 3 attempts logged: 500, 500, 200
 *
 * Why seed subscriptions directly instead of via POST /api/subscriptions:
 * the API's SSRF guard (lib/validate.ts) rejects http:// and loopback hosts
 * by design, so it would never accept http://127.0.0.1. createSubscription()
 * (the DB layer) has no such guard, which is exactly what a local test needs.
 *
 * Why force next_attempt_at = now() between worker runs: real retries are
 * scheduled 30s+ out via exponential backoff. Rewriting the timestamp is the
 * test-time equivalent of "fast-forward the clock" so the run finishes in
 * seconds instead of minutes.
 *
 * Exit code is 0 if every assertion passed, 1 otherwise -- so this can gate CI.
 */
import { randomUUID } from 'node:crypto';
import { getSql } from '../../lib/db.js';
import { createSubscription } from '../../lib/subscriptions.js';
import { startSmokeServer } from './serve.js';
import { startFakeReceiver } from './fake-receiver.js';

const API_PORT = Number(process.env.E2E_API_PORT ?? 3100);
const RECV_PORT = Number(process.env.E2E_RECV_PORT ?? 4100);
const BASE = `http://127.0.0.1:${API_PORT}`;

// ---------------------------------------------------------------------------
// Tiny assertion harness -- record results, print as we go, fail loud at end.
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function getJson(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

function workerHeaders(token = process.env.WORKER_SECRET ?? ''): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Make every pending delivery for our event due right now (skip the backoff). */
async function fastForwardRetries(eventId: string): Promise<void> {
  await getSql()`
    UPDATE deliveries
    SET next_attempt_at = now()
    WHERE event_id = ${eventId} AND status = 'pending'
  `;
}

async function deliveriesFor(eventId: string): Promise<any[]> {
  const { body } = await getJson(`/api/deliveries?eventId=${eventId}`);
  return body.deliveries ?? [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL not set (use --env-file=.env)');
  if (!process.env.WORKER_SECRET) throw new Error('WORKER_SECRET not set (use --env-file=.env)');

  const runId = randomUUID();
  const eventType = `e2e.${runId}`;

  // Seed two subscriptions pointing at our in-process receiver. They share a
  // secret so the single receiver can verify both (each real subscription has
  // its own, but the receiver only holds one key).
  const happy = await createSubscription({
    url: `http://127.0.0.1:${RECV_PORT}/hook`,
    eventTypes: [eventType],
  });
  const flaky = await createSubscription({
    url: `http://127.0.0.1:${RECV_PORT}/flaky`,
    eventTypes: [eventType],
  });
  const sharedSecret = happy.secret;
  await getSql()`
    UPDATE subscriptions SET secret = ${sharedSecret}
    WHERE id = ANY(${[happy.id, flaky.id]})
  `;

  // Start the receiver (fails /flaky twice, then succeeds) and the API.
  const receiver = startFakeReceiver({ port: RECV_PORT, secret: sharedSecret, flakyFails: 2 });
  const api = startSmokeServer({ port: API_PORT, log: false });
  await Promise.all([receiver.ready, api.ready]);

  let eventId = '';

  try {
    // -- 1. Ingest --------------------------------------------------------
    section('1. Ingest event (fan-out to 2 subscriptions)');
    const ingest = await postJson('/api/events', {
      eventType,
      payload: { orderId: 'ord_123', amount: 4200 },
      idempotencyKey: runId,
    });
    eventId = ingest.body.eventId;
    check('returns 202 Accepted', ingest.status === 202, ingest);
    check('schedules 2 deliveries', ingest.body.deliveriesScheduled === 2, ingest.body);
    check('returns an eventId', typeof eventId === 'string' && eventId.length > 0, ingest.body);

    // -- 2. Idempotent replay --------------------------------------------
    section('2. Re-ingest with same idempotency key');
    const replay = await postJson('/api/events', {
      eventType,
      payload: { orderId: 'ord_123', amount: 4200 },
      idempotencyKey: runId,
    });
    check('returns 200 (not 202)', replay.status === 200, replay);
    check('flagged as duplicate', replay.body.duplicate === true, replay.body);
    check('schedules 0 new deliveries', replay.body.deliveriesScheduled === 0, replay.body);
    check('same eventId as original', replay.body.eventId === eventId, replay.body);

    // -- 3. Two pending deliveries exist ---------------------------------
    section('3. Deliveries scheduled and pending');
    const initial = await deliveriesFor(eventId);
    check('two deliveries for the event', initial.length === 2, initial.map((d) => d.id));
    check('both pending', initial.every((d) => d.status === 'pending'), initial.map((d) => d.status));

    // -- 4. Worker auth --------------------------------------------------
    section('4. Worker authorization');
    const badAuth = await postJson('/api/worker', {}, workerHeaders('wrong-token'));
    check('rejects wrong bearer token (401)', badAuth.status === 401, badAuth);

    // -- 5. Worker run #1 ------------------------------------------------
    section('5. Worker run #1 (deliver happy, fail+retry flaky)');
    const run1 = await postJson('/api/worker', {}, workerHeaders());
    check('worker returns 200', run1.status === 200, run1);

    let rows = await deliveriesFor(eventId);
    const happyRow1 = rows.find((d) => d.subscriptionId === happy.id);
    const flakyRow1 = rows.find((d) => d.subscriptionId === flaky.id);
    check('happy delivery -> delivered', happyRow1?.status === 'delivered', happyRow1);
    check('happy attemptCount = 1', happyRow1?.attemptCount === 1, happyRow1);
    check('flaky delivery -> pending (queued for retry)', flakyRow1?.status === 'pending', flakyRow1);
    check('flaky attemptCount = 1', flakyRow1?.attemptCount === 1, flakyRow1);

    // -- 6. Worker runs #2 and #3 (fast-forward the backoff each time) ----
    section('6. Worker runs #2 and #3 (flaky succeeds on attempt 3)');
    await fastForwardRetries(eventId);
    await postJson('/api/worker', {}, workerHeaders());
    rows = await deliveriesFor(eventId);
    const flakyRow2 = rows.find((d) => d.subscriptionId === flaky.id);
    check('after run #2 flaky still pending', flakyRow2?.status === 'pending', flakyRow2);
    check('flaky attemptCount = 2', flakyRow2?.attemptCount === 2, flakyRow2);

    await fastForwardRetries(eventId);
    await postJson('/api/worker', {}, workerHeaders());
    rows = await deliveriesFor(eventId);
    const flakyRow3 = rows.find((d) => d.subscriptionId === flaky.id);
    check('after run #3 flaky delivered', flakyRow3?.status === 'delivered', flakyRow3);
    check('flaky attemptCount = 3', flakyRow3?.attemptCount === 3, flakyRow3);

    // -- 7. Attempt history ----------------------------------------------
    section('7. Flaky delivery attempt history');
    const detail = await getJson(`/api/deliveries/${flakyRow3?.id}`);
    const attempts = detail.body.delivery?.attempts ?? [];
    check('3 attempts logged', attempts.length === 3, attempts.map((a: any) => a.httpStatus));
    check(
      'status sequence is 500, 500, 200',
      attempts[0]?.httpStatus === 500 &&
        attempts[1]?.httpStatus === 500 &&
        attempts[2]?.httpStatus === 200,
      attempts.map((a: any) => a.httpStatus)
    );
    check('each attempt has a latency measurement', attempts.every((a: any) => typeof a.latencyMs === 'number'), attempts.map((a: any) => a.latencyMs));
  } finally {
    // ---- Teardown: remove this run's rows, then stop servers ----------
    section('Cleanup');
    if (eventId) {
      // deliveries has ON DELETE CASCADE -> delivery_attempts, so deleting
      // deliveries clears the attempt log too. Order respects the FKs:
      // deliveries -> events, deliveries -> subscriptions.
      await getSql()`DELETE FROM deliveries WHERE event_id = ${eventId}`;
      await getSql()`DELETE FROM events WHERE id = ${eventId}`;
    }
    await getSql()`DELETE FROM subscriptions WHERE id = ANY(${[happy.id, flaky.id]})`;
    console.log('  removed seeded subscriptions, event, and deliveries');

    await Promise.allSettled([receiver.close(), api.close()]);
    await getSql().end();
  }

  section('Result');
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\nE2E run crashed:', err);
  process.exitCode = 1;
});
