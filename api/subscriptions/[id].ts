import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  getSubscription,
  softDeleteSubscription,
  updateSubscription,
} from '../../lib/subscriptions.js';
import { validateWebhookUrl } from '../../lib/validate.js';
import type { UpdateSubscriptionInput } from '../../lib/types.js';

// 8-4-4-4-12 hex. Doesn't care about UUID version -- gen_random_uuid() is v4
// but we accept any value that matches the shape. The point isn't to parse the
// UUID for meaning -- it's to reject obvious garbage before we hit Postgres.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_EVENT_TYPES = 20;
const MAX_EVENT_TYPE_LENGTH = 100;

/**
 * Runtime validator for the PATCH body. All fields optional -- this is a
 * partial update, not a replacement. An empty body is legal and treated as a
 * read-through (the DB layer short-circuits to getSubscription).
 */
function parseUpdateInput(body: unknown):
  | { ok: true; value: UpdateSubscriptionInput }
  | { ok: false; error: string; field?: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const out: UpdateSubscriptionInput = {};

  if (b.url !== undefined) {
    if (typeof b.url !== 'string' || b.url.length === 0) {
      return { ok: false, error: 'url must be a non-empty string', field: 'url' };
    }
    out.url = b.url;
  }

  if (b.eventTypes !== undefined) {
    if (!Array.isArray(b.eventTypes)) {
      return { ok: false, error: 'eventTypes must be an array', field: 'eventTypes' };
    }
    if (b.eventTypes.length === 0) {
      return {
        ok: false,
        error: 'eventTypes must contain at least one entry',
        field: 'eventTypes',
      };
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
    out.eventTypes = [...new Set(b.eventTypes as string[])];
  }

  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') {
      return { ok: false, error: 'enabled must be a boolean', field: 'enabled' };
    }
    out.enabled = b.enabled;
  }

  return { ok: true, value: out };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Vercel captures the [id] segment into req.query.id. For single-segment
  // dynamic params this is always a string; arrays only happen for catch-all
  // routes ([...path].ts).
  const id = req.query.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    // 400 not 500: malformed input is the *client's* problem. Catching here
    // also avoids surfacing Postgres's 22P02 invalid_text_representation
    // error as an opaque internal_error.
    return res.status(400).json({ error: 'invalid_id', message: 'id must be a UUID' });
  }

  if (req.method === 'GET') {
    try {
      const subscription = await getSubscription(id);
      if (!subscription) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ subscription });
    } catch (err) {
      console.error('GET /api/subscriptions/[id] failed', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  if (req.method === 'PATCH') {
    const parsed = parseUpdateInput(req.body);
    if (!parsed.ok) {
      return res
        .status(400)
        .json({ error: 'invalid_input', message: parsed.error, field: parsed.field });
    }

    // SSRF guard re-runs on PATCH if (and only if) the caller is changing
    // the URL. Same discriminated-union mapping as POST.
    if (parsed.value.url !== undefined) {
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
    }

    try {
      const subscription = await updateSubscription(id, parsed.value);
      // null = no live subscription with that id (either never existed or
      // already soft-deleted). Same response as a GET miss.
      if (!subscription) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ subscription });
    } catch (err) {
      console.error('PATCH /api/subscriptions/[id] failed', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const deleted = await softDeleteSubscription(id);
      // false means the row was already deleted, or never existed. Same as
      // a GET 404 -- the resource is not currently here.
      if (!deleted) return res.status(404).json({ error: 'not_found' });
      // 204 No Content: idiomatic REST for "did what you asked, nothing
      // meaningful to put in the body".
      return res.status(204).end();
    } catch (err) {
      console.error('DELETE /api/subscriptions/[id] failed', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE, OPTIONS');
  return res.status(405).json({ error: 'method_not_allowed' });
}
