/**
 * Minimal Node HTTP server that wraps our Vercel-style handlers so we can
 * exercise the whole API locally with curl -- no `vercel dev`, no Vercel CLI
 * auth, no cron. Mirrors the rate-limiter project's smoke server.
 *
 *   npx tsx --env-file=.env scripts/_smoke/serve.ts
 *
 * Then from another terminal:
 *   curl -i -X POST http://localhost:3000/api/subscriptions \
 *        -H "Content-Type: application/json" \
 *        -d '{"url":"https://example.com/hook","eventTypes":["order.created"]}'
 *
 * The worker is cron-driven in production; here you just POST it yourself:
 *   curl -i -X POST http://localhost:3000/api/worker \
 *        -H "Authorization: Bearer $WORKER_SECRET"
 *
 * Maps URL paths to handlers (mimicking Vercel's file-system routing) and
 * shims the VercelResponse helpers (`status()`, `json()`, `end()`) the
 * handlers depend on.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { URL } from 'node:url';
import { fileURLToPath } from 'node:url';
import subscriptionsIndex from '../../api/subscriptions/index.js';
import subscriptionsId from '../../api/subscriptions/[id].js';
import eventsIndex from '../../api/events/index.js';
import deliveriesIndex from '../../api/deliveries/index.js';
import deliveriesId from '../../api/deliveries/[id].js';
import workerHandler from '../../api/worker.js';

type ExtendedRequest = IncomingMessage & {
  body?: unknown;
  query?: Record<string, string | string[]>;
};
type Handler = (req: ExtendedRequest, res: ServerResponse) => unknown | Promise<unknown>;

// Resolve a URL pathname to a handler + any captured route params. Mimics the
// subset of Vercel's file-system routing this project uses.
function resolveRoute(pathname: string):
  | { handler: Handler; params: Record<string, string | string[]> }
  | null {
  if (pathname === '/api/subscriptions') {
    return { handler: subscriptionsIndex as unknown as Handler, params: {} };
  }
  const subIdMatch = pathname.match(/^\/api\/subscriptions\/([^/]+)$/);
  if (subIdMatch) {
    return { handler: subscriptionsId as unknown as Handler, params: { id: subIdMatch[1]! } };
  }
  if (pathname === '/api/events') {
    return { handler: eventsIndex as unknown as Handler, params: {} };
  }
  if (pathname === '/api/deliveries') {
    return { handler: deliveriesIndex as unknown as Handler, params: {} };
  }
  const delIdMatch = pathname.match(/^\/api\/deliveries\/([^/]+)$/);
  if (delIdMatch) {
    return { handler: deliveriesId as unknown as Handler, params: { id: delIdMatch[1]! } };
  }
  if (pathname === '/api/worker') {
    return { handler: workerHandler as unknown as Handler, params: {} };
  }
  return null;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Add the chainable helpers our handlers expect from VercelResponse.
function decorateResponse(res: ServerResponse) {
  const r = res as ServerResponse & {
    status: (code: number) => typeof r;
    json: (body: unknown) => typeof r;
  };
  r.status = (code: number) => {
    r.statusCode = code;
    return r;
  };
  r.json = (body: unknown) => {
    if (!r.getHeader('Content-Type')) r.setHeader('Content-Type', 'application/json');
    r.end(JSON.stringify(body));
    return r;
  };
  return r;
}

export interface SmokeServer {
  server: Server;
  /** Resolves once the socket is listening. */
  ready: Promise<void>;
  close: () => Promise<void>;
}

/**
 * Build (but optionally don't log) the local API server. Exported so the e2e
 * harness can run the real handlers in-process instead of shelling out to a
 * separate `vercel dev`.
 */
export function startSmokeServer(opts: { port: number; log?: boolean }): SmokeServer {
  const { port } = opts;
  const log = opts.log ?? true;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const resolved = resolveRoute(url.pathname);

    if (log) console.log(`${new Date().toISOString()}  ${req.method}  ${url.pathname}`);

    if (!resolved) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
      return;
    }

    try {
      const reqWithBody = req as ExtendedRequest;
      reqWithBody.body = await readJsonBody(req);
      reqWithBody.query = { ...Object.fromEntries(url.searchParams), ...resolved.params };
      decorateResponse(res);
      await resolved.handler(reqWithBody, res);
    } catch (err) {
      console.error('handler error', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal_server_error' }));
      }
    }
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
// CLI entry point: only runs when executed directly (not when imported).
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  const s = startSmokeServer({ port });
  s.ready.then(() => {
    console.log(`Local smoke server listening on http://localhost:${port}`);
    console.log(
      `Try:  curl -i -X POST http://localhost:${port}/api/subscriptions -H "Content-Type: application/json" -d '{"url":"https://example.com/hook","eventTypes":["order.created"]}'`
    );
  });
}
