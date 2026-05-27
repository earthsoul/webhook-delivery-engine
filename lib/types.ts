// -----------------------------------------------------------------------------
// Domain types — the shape of subscriptions, events, deliveries, and attempts
// as the rest of the codebase sees them. snake_case lives only inside lib/db.
// -----------------------------------------------------------------------------

/**
 * Lifecycle of a single delivery row.
 *
 *  pending     -> waiting to be picked up by the worker.
 *  delivering  -> currently being attempted (claimed). Acts as a row-level
 *                 lock so two concurrent workers never grab the same row.
 *  delivered   -> received a 2xx response. Terminal.
 *  failed      -> max attempts reached without success. Terminal.
 */
export type DeliveryStatus = 'pending' | 'delivering' | 'delivered' | 'failed';

export interface Subscription {
  id: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  createdAt: string;
  // `secret` is intentionally not on the base type. It is only ever returned
  // on creation (see CreateSubscriptionResult) — list / get / update responses
  // must not echo it back.
}

export interface Event {
  id: string;
  idempotencyKey: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Delivery {
  id: string;
  eventId: string;
  subscriptionId: string;
  status: DeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
}

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  attemptNum: number;
  httpStatus: number | null;
  responseBody: string | null;
  latencyMs: number | null;
  error: string | null;
  attemptedAt: string;
}

export interface DeliveryWithAttempts extends Delivery {
  attempts: DeliveryAttempt[];
}

// -----------------------------------------------------------------------------
// API request / response shapes
// -----------------------------------------------------------------------------

export interface CreateSubscriptionInput {
  url: string;
  eventTypes: string[];
}

export interface CreateSubscriptionResult extends Subscription {
  /**
   * Plaintext HMAC signing secret. Returned once at creation time and never
   * again — the caller must store it. Used by the receiver to verify
   * X-Webhook-Signature on every incoming delivery.
   */
  secret: string;
}

/** Partial-update payload for PATCH /api/subscriptions/:id. */
export interface UpdateSubscriptionInput {
  url?: string;
  eventTypes?: string[];
  enabled?: boolean;
}

export interface IngestEventRequest {
  eventType: string;
  payload: Record<string, unknown>;
  /** Optional client-supplied dedupe key. Replays return the original eventId. */
  idempotencyKey?: string;
}

export interface IngestEventResult {
  eventId: string;
  deliveriesScheduled: number;
  message: string;
  /** True when the request matched an existing idempotencyKey. */
  duplicate?: boolean;
}

/** Filters accepted by GET /api/deliveries. All optional, AND-combined. */
export interface DeliveryQuery {
  eventId?: string;
  subscriptionId?: string;
  status?: DeliveryStatus;
}

/**
 * Summary returned by POST /api/worker. Useful for cron observability —
 * Vercel surfaces the response body in the cron run history.
 */
export interface WorkerSummary {
  swept: number;
  processed: number;
  delivered: number;
  retrying: number;
  failed: number;
}
