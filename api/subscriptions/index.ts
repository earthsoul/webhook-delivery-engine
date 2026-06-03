import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createSubscription, listSubscriptions } from '../../lib/subscriptions.js';
import { validateWebhookUrl } from '../../lib/validate.js';
import type { CreateSubscriptionInput } from '../../lib/types.js';

const MAX_EVENT_TYPES = 20;
const MAX_EVENT_TYPE_LENGTH = 100;

/**
 * Runtime validator for POST body. "Parse, don't validate":
 * returns the typed value on success or a structured error on failure.
 *
 * Every field crossing the network boundary is checked here -- TypeScript
 * types are erased at runtime, so `req.body as CreateSubscriptionInput` is a
 * promise to the compiler, not an actual check.
 */
function parseCreateInput(body: unknown):
  | { ok: true; value: CreateSubscriptionInput }
  | { ok: false; error: string; field?: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.url !== 'string' || b.url.length === 0) {
    return { ok: false, error: 'url must be a non-empty string', field: 'url' };
  }

  if (!Array.isArray(b.eventTypes)) {
    return { ok: false, error: 'eventTypes must be an array', field: 'eventTypes' };
  }
  if (b.eventTypes.length === 0) {
    return { ok: false, error: 'eventTypes must contain at least one entry', field: 'eventTypes' };
  }
  if (b.eventTypes.length > MAX_EVENT_TYPES) {
    return {
      ok: false,
      error: `eventTypes must contain at most ${MAX_EVENT_TYPES} entries`,
      field: 'eventTypes',
    };
  }
  for (const t of b.eventTypes) {
    if (typeof t !== 'string' || t.length === 0 || t.length > MAX_EVENT_TYPE_LENGTH) {
      return {
        ok: false,
        error: `each eventType must be a non-empty string up to ${MAX_EVENT_TYPE_LENGTH} characters`,
        field: 'eventTypes',
      };
    }
  }

  // De-duplicate silently. event_types is a set semantically; storing
  // ['order.created', 'order.created'] would just waste index space and
  // produce duplicate deliveries on fan-out.
  const eventTypes = [...new Set(b.eventTypes as string[])];

  return { ok: true, value: { url: b.url, eventTypes } };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    try {
      const subscriptions = await listSubscriptions();
      // Wrap the array in an object so we can add pagination metadata later
      // (e.g. `nextCursor`) without breaking clients.
      return res.status(200).json({ subscriptions });
    } catch (err) {
      console.error('GET /api/subscriptions failed', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  if (req.method === 'POST') {
    const parsed = parseCreateInput(req.body);
    if (!parsed.ok) {
      return res
        .status(400)
        .json({ error: 'invalid_input', message: parsed.error, field: parsed.field });
    }

    // SSRF guard. Discriminated union from validateWebhookUrl gives us
    // specific reasons -- we map each to a tailored 400 message so callers
    // know exactly what was wrong with their URL.
    const urlCheck = validateWebhookUrl(parsed.value.url);
    if (!urlCheck.ok) {
      switch (urlCheck.reason) {
        case 'invalid_url':
          return res
            .status(400)
            .json({ error: 'invalid_url', message: 'url is not a valid URL' });
        case 'protocol_not_https':
          return res.status(400).json({
            error: 'protocol_not_https',
            message: `url must use https:// (got ${urlCheck.protocol})`,
          });
        case 'private_ip_blocked':
          return res.status(400).json({
            error: 'private_ip_blocked',
            message: `url host ${urlCheck.host} is in a private/loopback/link-local range and cannot be used as a webhook destination`,
          });
      }
    }

    try {
      const subscription = await createSubscription(parsed.value);
      // 201 Created -- a new resource was created. The `secret` field is
      // present in the response only on this code path; subsequent GETs
      // will not echo it back.
      return res.status(201).json({ subscription });
    } catch (err) {
      console.error('POST /api/subscriptions failed', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  // RFC 7231: a 405 response MUST include an Allow header.
  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).json({ error: 'method_not_allowed' });
}
