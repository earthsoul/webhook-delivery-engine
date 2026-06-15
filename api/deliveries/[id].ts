import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDeliveryWithAttempts } from '../../lib/deliveries.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const id = req.query.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'invalid_id', message: 'id must be a UUID' });
  }

  try {
    const delivery = await getDeliveryWithAttempts(id);
    if (!delivery) return res.status(404).json({ error: 'not_found' });
    // The delivery object already carries its `attempts` array (oldest first).
    return res.status(200).json({ delivery });
  } catch (err) {
    console.error('GET /api/deliveries/[id] failed', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
