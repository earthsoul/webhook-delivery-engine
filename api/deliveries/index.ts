import type { VercelRequest, VercelResponse } from '@vercel/node';
import { queryDeliveries } from '../../lib/deliveries.js';
import type { DeliveryQuery, DeliveryStatus } from '../../lib/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUSES: readonly DeliveryStatus[] = [
  'pending',
  'delivering',
  'delivered',
  'failed',
];

// Cap the page size. Clients may request fewer via ?limit=, but never more --
// an unbounded limit would let one request scan the whole table.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Pull a single string value out of req.query, which can be string |
 * string[] | undefined. Repeated query params (?status=a&status=b) arrive as
 * an array; we take the first and ignore the rest rather than erroring.
 */
function firstParam(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const eventId = firstParam(req.query.eventId);
  const subscriptionId = firstParam(req.query.subscriptionId);
  const status = firstParam(req.query.status);
  const limitRaw = firstParam(req.query.limit);

  // Validate each filter that was supplied. Unsupplied filters are fine --
  // they just widen the result set.
  const q: DeliveryQuery = {};

  if (eventId !== undefined) {
    if (!UUID_RE.test(eventId)) {
      return res.status(400).json({ error: 'invalid_filter', message: 'eventId must be a UUID' });
    }
    q.eventId = eventId;
  }

  if (subscriptionId !== undefined) {
    if (!UUID_RE.test(subscriptionId)) {
      return res
        .status(400)
        .json({ error: 'invalid_filter', message: 'subscriptionId must be a UUID' });
    }
    q.subscriptionId = subscriptionId;
  }

  if (status !== undefined) {
    if (!VALID_STATUSES.includes(status as DeliveryStatus)) {
      return res.status(400).json({
        error: 'invalid_filter',
        message: `status must be one of: ${VALID_STATUSES.join(', ')}`,
      });
    }
    q.status = status as DeliveryStatus;
  }

  // Parse + clamp the limit. Garbage (?limit=abc) falls back to the default
  // rather than erroring -- a bad limit shouldn't fail an otherwise-valid query.
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      limit = Math.min(parsed, MAX_LIMIT);
    }
  }

  try {
    const deliveries = await queryDeliveries(q, limit);
    // Wrapped in an object so pagination metadata (nextCursor, etc.) can be
    // added later without breaking clients.
    return res.status(200).json({ deliveries });
  } catch (err) {
    console.error('GET /api/deliveries failed', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
