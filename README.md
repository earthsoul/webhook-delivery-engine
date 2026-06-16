# Webhook Delivery Engine

A reliable webhook delivery service deployed on Vercel. Clients register subscriptions (a URL plus the event types they care about), `POST` events to the service, and the engine fans out HTTP deliveries to every matching subscriber — with **idempotent ingestion**, **HMAC-SHA256 signing**, **at-least-once delivery**, **retries with exponential backoff + jitter**, and a **durable log of every individual attempt**.

It's the kind of system that sits behind "Settings → Webhooks" in products like Stripe, GitHub, and Shopify.

- **Interactive API docs:** served at `/` (Scalar, rendered from [`public/openapi.yaml`](public/openapi.yaml)).
- **One-command local end-to-end test:** `npm run e2e`.
- **Companion project:** [**rate-limiter-service**](https://github.com/earthsoul/rate-limiter-service) — a configurable rate-limiting microservice (sliding-window counters in Redis, rules in Postgres). It's the natural front door for this engine: a single `POST /api/check` in front of the public endpoints adds per-tenant quotas (see [Security and abuse prevention](#security-and-abuse-prevention)).

---

## Contents

- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [API](#api)
- [Quick start (local)](#quick-start-local)
- [Demo: drive the full lifecycle with curl](#demo-drive-the-full-lifecycle-with-curl)
- [Delivery semantics](#delivery-semantics)
- [Verifying a webhook signature](#verifying-a-webhook-signature)
- [Security and abuse prevention](#security-and-abuse-prevention)
- [Deployment](#deployment)
- [Testing](#testing)
- [Key design decisions](#key-design-decisions)

---

## How it works

```mermaid
flowchart LR
  C[Client] -->|POST /api/events| E[(events)]
  E -->|fan-out: 1 row per matching subscription| D[(deliveries)]
  subgraph Worker [Worker — Vercel Cron, every minute]
    direction TB
    S[sweep stuck rows] --> CL["claim due pending<br/>FOR UPDATE SKIP LOCKED"]
    CL --> H[HTTP POST + HMAC sign]
    H --> R{2xx?}
    R -->|yes| OK[status = delivered]
    R -->|no| RT["record attempt<br/>schedule retry w/ backoff"]
  end
  D --> Worker
  H -->|signed request| W[Subscriber URL]
  H --> A[("delivery_attempts<br/>append-only log")]
```

1. **Ingest.** `POST /api/events` records the event and, in the same transaction, fans out one `pending` delivery row per matching enabled subscription. An optional `idempotencyKey` makes retries safe — a replay returns the original event and creates no duplicate deliveries.
2. **Claim.** A worker (driven by Vercel Cron once a minute) atomically claims a batch of due deliveries with `SELECT … FOR UPDATE SKIP LOCKED`, flipping them to `delivering`. This is what makes concurrent workers safe — two runs never grab the same row.
3. **Deliver.** Each claimed delivery is `POST`ed to the subscriber with an HMAC-SHA256 signature and a 10s timeout. The HTTP call happens *outside* any DB transaction; only the two quick writes (attempt log + status transition) are transactional.
4. **Record & retry.** Every attempt is appended to `delivery_attempts` (status, latency, response body, error). A `2xx` marks the delivery `delivered`; anything else schedules a retry with exponential backoff until `max_attempts`, after which it's `failed`.
5. **Recover.** Before claiming, the worker sweeps rows stuck in `delivering` (a previous run crashed mid-flight) back to `pending` so they're retried.

**No queue service, no Redis.** The `deliveries` table *is* the queue — claimed atomically, swept for stuck rows. One fewer moving part to operate, and the queue inherits Postgres's durability and transactional guarantees for free.

---

## Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript + Node.js 20 (strict, ESM) |
| Runtime | Vercel serverless functions + Cron |
| Database | Supabase Postgres (via the `postgres` driver against the pooler) |
| Crypto | Node built-in `crypto` (HMAC-SHA256, `timingSafeEqual`) |
| HTTP client | Native `fetch` + `AbortController` |
| Docs | OpenAPI 3.0 + Scalar |

---

## Project structure

```
api/                      Vercel serverless functions (the HTTP surface)
  events/index.ts         POST /api/events            — ingest + fan-out
  subscriptions/index.ts  GET/POST /api/subscriptions — list / create
  subscriptions/[id].ts   GET/PATCH/DELETE            — read / update / soft-delete
  deliveries/index.ts     GET /api/deliveries         — list with filters
  deliveries/[id].ts      GET /api/deliveries/:id     — one delivery + attempts
  worker.ts               GET/POST /api/worker        — the delivery loop (cron)
lib/                      Framework-agnostic core (no Vercel types leak in)
  db.ts                   Lazy-singleton Postgres client (pooler-safe)
  types.ts                Domain + API types (camelCase; snake_case stays in db)
  validate.ts             SSRF guard for subscription URLs
  subscriptions.ts        Subscription queries + secret generation
  events.ts               Idempotent event insert (ON CONFLICT DO NOTHING)
  deliveries.ts           Fan-out, atomic claim, finalize, sweep, queries
  deliver.ts              HMAC signing + a single HTTP delivery attempt
  backoff.ts              Exponential backoff schedule with jitter
public/                   Served statically at the root by Vercel
  index.html              Scalar interactive API reference
  openapi.yaml            OpenAPI 3.0 spec (linted)
scripts/
  migrate.ts              One-shot schema migration (npm run migrate)
  _smoke/
    serve.ts              Local server that runs the real handlers (no vercel dev)
    fake-receiver.ts      A subscriber that verifies signatures (test target)
    e2e.ts                In-process end-to-end test of the whole lifecycle
```

---

## API

Full interactive reference at `/` once deployed (or locally via `npm run smoke` → `http://localhost:3000`).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/subscriptions` | Create a subscription; returns the signing `secret` **once** |
| `GET` | `/api/subscriptions` | List subscriptions (never returns secrets) |
| `GET` | `/api/subscriptions/:id` | Fetch one subscription |
| `PATCH` | `/api/subscriptions/:id` | Partial update (url / eventTypes / enabled) |
| `DELETE` | `/api/subscriptions/:id` | Soft delete (preserves history) |
| `POST` | `/api/events` | Ingest an event → fans out deliveries (`202`, or `200` on replay) |
| `GET` | `/api/deliveries` | List deliveries (filter by `eventId`, `subscriptionId`, `status`) |
| `GET` | `/api/deliveries/:id` | One delivery with its full attempt history |
| `GET`/`POST` | `/api/worker` | Run the delivery loop (bearer-token protected; cron-driven) |

---

## Quick start (local)

**Prerequisites:** Node.js 20+, and a Postgres database. Any Postgres works — Supabase, or a throwaway container:

```bash
docker run --rm -d --name webhook-pg -p 55432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=webhook postgres:16
```

```bash
# 1. Install
npm install

# 2. Configure — copy the example and fill in your values
cp .env.example .env
#   POSTGRES_URL  -> your database (the docker one above is
#                    postgresql://postgres:postgres@localhost:55432/webhook)
#   WORKER_SECRET -> any long random string

# 3. Create the schema
npm run migrate

# 4a. Run the full end-to-end test (recommended first step)
npm run e2e

# 4b. …or start the API locally and poke it by hand
npm run smoke   # serves the API + interactive docs on http://localhost:3000
```

`npm run e2e` boots the real handlers and a fake subscriber in-process, then asserts the entire lifecycle: ingest + fan-out, idempotent replay, worker auth, happy-path delivery, fail-then-retry, and the per-attempt log. It cleans up after itself and exits non-zero on any failure.

---

## Demo: drive the full lifecycle with curl

With `npm run smoke` running on `http://localhost:3000`. Use a real HTTPS receiver you control — e.g. grab a URL from [webhook.site](https://webhook.site) — because the SSRF guard rejects `http://` and private hosts by design.

```bash
# 1. Create a subscription (note the `secret` in the response — shown once)
curl -s -X POST http://localhost:3000/api/subscriptions \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://webhook.site/your-uuid","eventTypes":["order.created"]}'

# 2. Ingest an event -> 202, fans out to matching subscriptions
curl -s -X POST http://localhost:3000/api/events \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"order.created","payload":{"orderId":"ord_123"},"idempotencyKey":"ord_123-created"}'

# 3. Re-send the same event -> 200 duplicate, no new deliveries (idempotent)
curl -s -X POST http://localhost:3000/api/events \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"order.created","payload":{"orderId":"ord_123"},"idempotencyKey":"ord_123-created"}'

# 4. Run the worker to deliver (cron does this every minute in production)
curl -s -X POST http://localhost:3000/api/worker \
  -H "Authorization: Bearer $WORKER_SECRET"

# 5. Inspect deliveries and the per-attempt log
curl -s "http://localhost:3000/api/deliveries?eventId=<eventId-from-step-2>"
curl -s "http://localhost:3000/api/deliveries/<deliveryId>"
```

---

## Delivery semantics

- **At-least-once.** A receiver may see the same delivery more than once (e.g. it returned `200` but the connection dropped before we recorded it). Receivers should dedupe on the `X-Webhook-ID` header.
- **Retry schedule.** After a failure, retries are scheduled at **30s → 60s → 120s → 300s → 600s** (then capped at 600s), each with up to **10s of random jitter** to avoid a synchronized "thundering herd" when a downed receiver recovers. Default `max_attempts` is **5**.
- **What counts as success.** Only a `2xx` response. `3xx` is treated as failure (we never follow redirects — see security below), as is any timeout or transport error.
- **10s timeout** per attempt, covering DNS + TCP + TLS + body, via `AbortSignal.timeout`.

---

## Verifying a webhook signature

Every delivery carries three headers:

| Header | Meaning |
|---|---|
| `X-Webhook-ID` | The delivery id (use it to dedupe) |
| `X-Webhook-Timestamp` | Unix seconds when the request was signed |
| `X-Webhook-Signature` | `sha256=<hex>` — HMAC-SHA256 of the **raw body**, keyed by your subscription secret |

Verify over the **raw bytes** you received (not a re-serialized object — key reordering would change the bytes and break verification):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, signatureHeader, secret) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

A runnable reference implementation lives in [`scripts/_smoke/fake-receiver.ts`](scripts/_smoke/fake-receiver.ts).

---

## Security and abuse prevention

A webhook service makes outbound HTTP requests on behalf of whoever called it, so input validation and abuse prevention are first-class concerns.

### In place

- **SSRF guard on subscription URLs.** Rejects any URL that is malformed, not `https://`, or whose host is an IP literal in a private / loopback / link-local / multicast / CGNAT range (IPv4 + IPv6, including v4-mapped forms). Stops the obvious `http://169.254.169.254/…` probe at the door. See [`lib/validate.ts`](lib/validate.ts).
- **No redirect following on delivery.** `fetch` uses `redirect: 'manual'`, so a `307 Location: http://10.0.0.5/` can't smuggle a request into private space. `3xx` is a delivery failure.
- **HMAC-SHA256 signing on every payload.** Receivers verify authenticity; the secret is generated server-side and returned only once.
- **Constant-time secret comparison.** Worker auth uses `timingSafeEqual`, not `===`, so the token can't be recovered byte-by-byte via response timing.
- **Response-body cap (2 KB).** A misbehaving receiver can't OOM the function or bloat the DB with a giant error body.
- **Payload-size cap (256 KB) on ingest**, and bounded `eventTypes` / `idempotencyKey` lengths.
- **Soft delete on subscriptions.** Preserves the delivery audit trail and foreign-key integrity.

### Deliberately not in place (and how I'd close the gap)

- **No authentication on the public endpoints.** Anyone can create a subscription or ingest an event. In production these sit behind a per-tenant API key with per-tenant quotas.
- **No rate limiting.** A client could spam-create subscriptions or pump events. The natural fix is the companion **[rate-limiter-service](https://github.com/earthsoul/rate-limiter-service)** (a sibling portfolio project) — a single `POST /api/check` per inbound request.
- **No DNS-rebinding mitigation at delivery time.** The validator checks IP literals, but `https://attacker.com` can mutate DNS between validation and delivery. Real protection resolves the host at delivery time, validates the resolved IP, and pins the connection to it via a custom undici `Agent` with a `connect` hook.

These are scoped choices, not misses — none change the architecture, and all are short follow-on work.

---

## Deployment

Deploys to Vercel as-is. Set these environment variables in the Vercel project:

| Variable | Purpose |
|---|---|
| `POSTGRES_URL` | Supabase **pooler** URL, Transaction mode, port `6543` |
| `WORKER_SECRET` | Bearer token for manual worker calls |
| `CRON_SECRET` | Bearer token Vercel Cron sends automatically on the scheduled call |

[`vercel.json`](vercel.json) schedules `/api/worker` every minute and pins functions to a region (`iad1`) — **set this to match your database's region** to minimize per-query latency.

> **Cron on Hobby vs Pro:** Vercel's Hobby plan limits cron to once per day. For sub-minute scheduling either use the Pro plan, or trigger `/api/worker` from an external scheduler (e.g. cron-job.org) with `Authorization: Bearer <WORKER_SECRET>`.

---

## Testing

```bash
npm run typecheck   # strict TypeScript, no emit
npm run e2e         # full in-process lifecycle test (needs a migrated DB)
```

The end-to-end test (`scripts/_smoke/e2e.ts`) is the primary safety net: it exercises ingestion, idempotency, fan-out, worker authorization, signed delivery, and the fail → retry → succeed path with the durable attempt log — fast-forwarding the backoff timers so it finishes in seconds.

---

## Key design decisions

- **Table-as-queue instead of a dedicated queue.** `FOR UPDATE SKIP LOCKED` gives safe concurrent claiming; Postgres gives durability and transactions. One fewer service to run.
- **HTTP call outside the transaction.** A slow (up to 10s) delivery never holds a DB connection or row lock. Only the attempt-log write and status flip are transactional.
- **Idempotency via `INSERT … ON CONFLICT DO NOTHING RETURNING`.** Race-free at the database level — no read-then-write window.
- **Append-only attempt log.** Every attempt is a row, so the full history (statuses, latencies, errors) is queryable forever — invaluable for debugging "why didn't my webhook arrive?".
- **`lib/` has no Vercel types.** The core is framework-agnostic and unit-testable; only the thin `api/` handlers know about `VercelRequest`/`VercelResponse`.

---

## License

MIT
