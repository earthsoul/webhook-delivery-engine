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
