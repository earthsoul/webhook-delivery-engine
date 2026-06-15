/**
 * A standalone "subscriber" for exercising the delivery engine locally. It is
 * the destination a webhook gets delivered TO -- the mirror image of the
 * engine that delivers webhooks.
 *
 * Run it directly:
 *   RECEIVER_SECRET=whsec_xxx npx tsx scripts/_smoke/fake-receiver.ts
 *
 * Or import startFakeReceiver() to embed it in a test harness (see
 * scripts/_smoke/e2e.ts), where the secret is known only at runtime.
 *
 * What it does on every incoming POST:
 *   1. Reads the raw body (signature must be verified over the exact bytes
 *      we received, NOT over a re-serialised object -- key re-ordering would
 *      change the bytes and break verification).
 *   2. Recomputes HMAC-SHA256 over the raw body with the configured secret and
 *      compares it to the X-Webhook-Signature header using timingSafeEqual.
 *   3. Logs the delivery id, signature validity, and a body preview.
 *   4. Responds based on the path, so tests can drive specific outcomes:
 *        POST /hook        -> 200  (happy path)
 *        POST /fail        -> 500  (forces the engine to retry)
 *        POST /flaky       -> 500 the first flakyFails times, then 200
 *        POST /timeout     -> never responds (engine hits its 10s timeout)
 *
 * This is dev tooling -- it has no dependency on the engine's own code beyond
 * mirroring its signing scheme, so it doubles as living documentation of how
 * a real subscriber verifies our webhooks.
 */
import { createServer, type Server } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface FakeReceiverOptions {
  port: number;
  secret: string;
  /** How many times /flaky returns 500 before it starts returning 200. */
  flakyFails?: number;
  /** Set false to silence the per-request log (the e2e harness does this). */
  log?: boolean;
}

export interface FakeReceiver {
  server: Server;
  /** Resolves once the socket is listening. */
  ready: Promise<void>;
  close: () => Promise<void>;
}

/**
 * Verify a webhook signature exactly as a real subscriber would. This is the
 * snippet worth copying into the README's "verifying webhooks" section.
 */
export function verifySignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  // Length check first: timingSafeEqual throws on a length mismatch, and the
  // length comparison itself doesn't leak secret bytes.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Start a fake subscriber. Returns the server plus a `ready` promise that
 * resolves once it's listening and a `close` helper for clean teardown.
 */
export function startFakeReceiver(opts: FakeReceiverOptions): FakeReceiver {
  const { port, secret } = opts;
  const flakyFails = opts.flakyFails ?? 2;
  const log = opts.log ?? true;

  let flakyCount = 0;

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const sig = req.headers['x-webhook-signature'] as string | undefined;
      const id = req.headers['x-webhook-id'] as string | undefined;
      const valid = verifySignature(raw, sig, secret);
      const path = (req.url ?? '/').split('?')[0];

      if (log) {
        console.log(
          `${new Date().toISOString()}  ${req.method} ${path}  id=${id ?? '-'}  sigValid=${valid}  body=${raw.slice(0, 100)}`
        );
      }

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
        if (flakyCount <= flakyFails) {
          res.statusCode = 500;
          return res.end(JSON.stringify({ ok: false, attempt: flakyCount, willSucceedAfter: flakyFails }));
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

  const ready = new Promise<void>((resolve) => {
    server.listen(port, () => resolve());
  });

  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  return { server, ready, close };
}

// ---------------------------------------------------------------------------
// CLI entry point: only runs when this file is executed directly (not when
// imported by the e2e harness). Reads config from the environment.
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.RECEIVER_PORT ?? 4000);
  const secret = process.env.RECEIVER_SECRET ?? 'whsec_test';
  const flakyFails = Number(process.env.FLAKY_FAILS ?? 2);

  const r = startFakeReceiver({ port, secret, flakyFails });
  r.ready.then(() => {
    console.log(`Fake receiver on http://127.0.0.1:${port}`);
    console.log(`  secret=${secret}  flakyFails=${flakyFails}`);
    console.log(`  routes: /hook (200), /fail (500), /flaky (500 x${flakyFails} then 200), /timeout (hang)`);
  });
}
