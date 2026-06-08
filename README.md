# Webhook Delivery Engine

A reliable webhook delivery service deployed on Vercel. Clients register subscriptions (a URL plus the event types they care about), POST events to the service, and the engine fans out HTTP deliveries to every matching subscriber — with retries, exponential backoff, HMAC-SHA256 signing, and a durable log of every individual attempt.

> Status: scaffold only. Build in progress.

## Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript + Node.js 20 |
| Runtime | Vercel serverless functions + Cron |
| Database | Supabase Postgres (via the `postgres` driver against the pooler) |
| Crypto | Node built-in `crypto` (HMAC-SHA256) |
| HTTP client | Native `fetch` + `AbortController` |

No queue service, no Redis. The `deliveries` table itself is the queue — claimed atomically with `UPDATE ... RETURNING`, swept periodically for stuck rows.

---

## Security and abuse prevention

A webhook delivery service is, by design, a service that makes outbound HTTP requests on behalf of whoever called it. That makes input validation and abuse prevention first-class concerns, not afterthoughts.

### What's in place

- **SSRF guard on subscription URLs.** `POST /api/subscriptions` rejects any URL that is malformed, not `https://`, or whose host is an IP literal in a private / loopback / link-local / multicast / CGNAT range (IPv4 + IPv6, including v4-mapped IPv6 forms). Stops the obvious "register a webhook for `http://169.254.169.254/...`" probe attempt at the door. See [`lib/validate.ts`](lib/validate.ts).
- **HMAC-SHA256 signing on every outgoing payload** (planned commit 14–15) — receivers can verify the request actually came from this service.
- **Soft delete on subscriptions.** Hard `DELETE` is not exposed; the API stamps `deleted_at` instead. Preserves the delivery audit trail and keeps foreign-key integrity intact.
- **Worker is bearer-token protected.** Only callers presenting `Authorization: Bearer ${WORKER_SECRET}` can drive the delivery loop — Vercel Cron is the one legitimate caller.

### What's deliberately not in place (and how I'd close the gap)

- **No authentication on `POST /api/subscriptions`.** Anyone on the internet can register a subscription. In production this endpoint sits behind a per-tenant API key with a per-tenant subscription quota.
- **No rate limiting on subscription / event creation.** A single client could spam-create thousands of subscriptions or pump millions of events. The natural fix here is the **companion [`rate-limiter`](../rate-limiter) project** — a sibling service in this portfolio that does exactly this, configurable per-route. Wiring it up is a small operational change (a single `POST /api/check` per inbound request); the architecture is already designed to compose cleanly with it.
- **No DNS-rebinding mitigation at delivery time.** The URL validator only checks IP literals; an attacker can register `https://attacker.com` and mutate DNS between validation and delivery. Real protection requires resolving the hostname at delivery time, validating the resolved IP, and pinning the connection to that IP — typically via a custom undici `Agent` with a `connect` hook.
- **No payload-size cap on event ingest.** Easy to add (`Content-Length` check + 413 Payload Too Large).
- **No redirect handling on outgoing deliveries.** Will be addressed in the deliver commit by setting `redirect: 'manual'` on the `fetch` call so a `307 Location: http://10.0.0.5/` can't smuggle the request to private space.

These omissions are scoped intentionally — none change the architecture, all are short follow-on work — and called out here so a reader knows what was a *choice* vs a *miss*.
