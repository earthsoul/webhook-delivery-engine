import { createHmac } from 'node:crypto';

// -----------------------------------------------------------------------------
// HMAC-SHA256 payload signing
//
// Every outgoing webhook is signed so the receiver can verify it actually
// came from this service. The receiver knows the same secret (returned once
// at subscription creation) and recomputes the HMAC over the raw request
// body. If the recomputed value matches the X-Webhook-Signature header,
// the request is authentic.
//
// Format: 'sha256=' + lowercase hex of HMAC-SHA256(secret, payload).
// The 'sha256=' prefix is conventional (matches Stripe / GitHub / Shopify)
// and lets the format evolve later -- you could ship sha384= alongside,
// or eventually remove sha256 if it's deprecated.
// -----------------------------------------------------------------------------

export function signPayload(payload: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

// -----------------------------------------------------------------------------
// HTTP delivery
//
// One attempt at delivering a single payload to a single subscriber URL.
// The function never throws -- network errors, timeouts, and non-2xx responses
// all return a structured result. The worker reads that result and decides
// whether to schedule a retry, mark the delivery failed, or mark it delivered.
//
// Hard guarantees this function makes:
//   - HMAC-SHA256 signature on every request.
//   - 10-second total timeout via AbortSignal (covers DNS + TCP + TLS + body).
//   - redirect: 'manual'  -- never follow 3xx. Forces receivers to return 2xx
//     and closes a popular SSRF bypass (308 Location: http://10.0.0.5/).
//   - A clear User-Agent so receivers can recognise our traffic in their logs.
// -----------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = 'webhook-engine/0.1';

export interface DeliverArgs {
  url: string;
  payload: Record<string, unknown>;
  secret: string;
  deliveryId: string;
}

export interface DeliveryAttemptResult {
  /** true iff the receiver returned 2xx. 3xx and any error -> false. */
  success: boolean;
  /** HTTP status code, or null if no response was received (network error / timeout). */
  httpStatus: number | null;
  /** Response body as text, or null if no response was received. */
  responseBody: string | null;
  /** Wall-clock duration of the attempt, in milliseconds. */
  latencyMs: number;
  /** Error message on transport failure (timeout, DNS, TCP). null on HTTP success or non-2xx. */
  error: string | null;
}

export async function deliverWebhook(args: DeliverArgs): Promise<DeliveryAttemptResult> {
  const body = JSON.stringify(args.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(body, args.secret);
  const start = Date.now();

  try {
    const res = await fetch(args.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-Webhook-ID': args.deliveryId,
        'X-Webhook-Timestamp': String(timestamp),
        'X-Webhook-Signature': signature,
      },
      body,
      // 'manual' means undici returns the 3xx response as-is; we never
      // follow Location. This blocks the redirect-based SSRF bypass and
      // treats 3xx as a delivery failure (receivers should return 2xx).
      redirect: 'manual',
      // Single timeout that covers the whole request lifecycle. Aborts the
      // socket if any phase exceeds the budget.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // Read the body even on non-2xx -- it's useful for the per-attempt log.
    // (response_body truncation comes in the next commit; for now we capture
    //  the full body verbatim.)
    const responseBody = await res.text();

    return {
      success: res.ok,
      httpStatus: res.status,
      responseBody,
      latencyMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    // Reaches here on: DNS failure, TCP refused, TLS handshake failure,
    // 10s timeout (AbortError), or a malformed response. fetch itself
    // throws TypeError for "fetch failed" -- we want the underlying cause.
    const message =
      err instanceof Error
        ? err.cause instanceof Error
          ? `${err.message}: ${err.cause.message}`
          : err.message
        : 'unknown delivery error';
    return {
      success: false,
      httpStatus: null,
      responseBody: null,
      latencyMs: Date.now() - start,
      error: message,
    };
  }
}
