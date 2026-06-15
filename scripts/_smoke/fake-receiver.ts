/**
 * A standalone "subscriber" for exercising the delivery engine locally. It is
 * the destination a webhook gets delivered TO -- the mirror image of the
 * engine that delivers webhooks.
 *
 *   RECEIVER_SECRET=whsec_xxx npx tsx scripts/_smoke/fake-receiver.ts
 *
 * What it does on every incoming POST:
 *   1. Reads the raw body (signature must be verified over the exact bytes
 *      we received, NOT over a re-serialised object -- key re-ordering would
 *      change the bytes and break verification).
 *   2. Recomputes HMAC-SHA256 over the raw body with RECEIVER_SECRET and
 *      compares it to the X-Webhook-Signature header using timingSafeEqual.
 *   3. Logs the delivery id, signature validity, and a body preview.
 *   4. Responds based on the path, so tests can drive specific outcomes:
 *        POST /hook        -> 200  (happy path)
 *        POST /fail        -> 500  (forces the engine to retry)
 *        POST /flaky       -> 500 the first FLAKY_FAILS times, then 200
 *        POST /timeout     -> never responds (engine hits its 10s timeout)
 *
 * This is dev tooling -- it has no dependency on the engine's own code beyond
 * mirroring its signing scheme, so it doubles as living documentation of how
 * a real subscriber verifies our webhooks.
 */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.RECEIVER_PORT ?? 4000);
const SECRET = process.env.RECEIVER_SECRET ?? 'whsec_test';
// How many times /flaky fails before succeeding -- lets a test prove the
// retry path ends in an eventual delivery.
const FLAKY_FAILS = Number(process.env.FLAKY_FAILS ?? 2);

let flakyCount = 0;

/**
 * Verify a webhook signature exactly as a real subscriber would. This is the
 * snippet worth copying into the README's "verifying webhooks" section.
 */
function verifySignature(rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = 'sha256=' + createHmac('sha256', SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  // Length check first: timingSafeEqual throws on a length mismatch, and the
  // length comparison itself doesn't leak secret bytes.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
  req.on('end', () => {
    const sig = req.headers['x-webhook-signature'] as string | undefined;
    const id = req.headers['x-webhook-id'] as string | undefined;
    const valid = verifySignature(raw, sig);
    const path = (req.url ?? '/').split('?')[0];

    console.log(
      `${new Date().toISOString()}  ${req.method} ${path}  id=${id ?? '-'}  sigValid=${valid}  body=${raw.slice(0, 100)}`
    );

    // Reject anything whose signature doesn't verify, regardless of path --
    // a real subscriber must never trust an unsigned/forged request.
    if (!valid) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ ok: false, error: 'invalid_signature' }));
    }

    if (path === '/fail') {
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'forced_failure' }));
    }

    if (path === '/flaky') {
      flakyCount += 1;
      if (flakyCount <= FLAKY_FAILS) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ ok: false, attempt: flakyCount, willSucceedAfter: FLAKY_FAILS }));
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, succeededOnAttempt: flakyCount }));
    }

    if (path === '/timeout') {
      // Intentionally never respond -- the engine should abort at its 10s
      // timeout and log a transport error.
      return;
    }

    // Default happy path.
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  });
});

server.listen(PORT, () => {
  console.log(`Fake receiver on http://127.0.0.1:${PORT}`);
  console.log(`  secret=${SECRET}  flakyFails=${FLAKY_FAILS}`);
  console.log(`  routes: /hook (200), /fail (500), /flaky (500 x${FLAKY_FAILS} then 200), /timeout (hang)`);
});
