// The whole app as one fetch handler, shared by the Cloudflare Worker (src/worker.js) and the
// Node/Docker server (src/node.js). Each entry supplies `env` (DB, AI, secrets) and a static-file server.
import { checkAuth } from './auth.js';
import * as analyze from './api/analyze.js';
import * as embed from './api/embed.js';
import * as items from './api/items.js';
import * as keep from './api/keep.js';
import * as purge from './api/purge.js';
import * as restore from './api/restore.js';
import * as trash from './api/trash.js';
import * as xCallback from './api/x/callback.js';
import * as xLlmcheck from './api/x/llmcheck.js';
import * as xLogin from './api/x/login.js';
import * as xProcess from './api/x/process.js';
import * as xStatus from './api/x/status.js';
import * as xSync from './api/x/sync.js';

const ROUTES = {
  '/api/items': items, '/api/embed': embed, '/api/analyze': analyze,
  '/api/trash': trash, '/api/restore': restore, '/api/purge': purge, '/api/keep': keep,
  '/api/x/login': xLogin, '/api/x/callback': xCallback, '/api/x/status': xStatus,
  '/api/x/sync': xSync, '/api/x/process': xProcess, '/api/x/llmcheck': xLlmcheck,
};

// Cross-site request forgery: the browser attaches the site password (Basic auth) or the Access cookie
// to requests that other sites trigger, and several API calls spend money (X reads and writes, the
// LLM) or remove bookmarks on X. The page itself only calls the API same-origin, with JSON bodies, so:
// - refuse API requests the browser marks as started by another site (Sec-Fetch-Site);
// - require application/json on writes: an HTML form cannot send it, and a cross-origin fetch with it
//   needs a CORS preflight this app never answers. This also covers browsers that omit Sec-Fetch-*
//   (plain-http origins other than localhost).
// The X OAuth callback is the one cross-site navigation the app expects.
export function forgery(request, pathname) {
  if (!pathname.startsWith('/api/') || pathname === '/api/x/callback') return null;
  const site = request.headers.get('Sec-Fetch-Site');
  if (site === 'cross-site' || site === 'same-site') return Response.json({ error: 'cross-site request refused' }, { status: 403 });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return Response.json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }
  return null;
}

export async function handle(request, env, serveStatic) {
  const { pathname } = new URL(request.url);
  if (pathname === '/healthz') return Response.json({ ok: true }); // unauthenticated liveness probe, no data
  const forged = forgery(request, pathname);
  if (forged) return forged;
  const denied = await checkAuth(request, env);
  if (denied) return denied;

  let res;
  const route = ROUTES[pathname];
  if (route) {
    const fn = route[`onRequest${request.method[0]}${request.method.slice(1).toLowerCase()}`];
    try {
      res = fn ? await fn({ request, env }) : new Response('Method Not Allowed', { status: 405 });
    } catch (e) {
      console.error(pathname, e);
      res = Response.json({ error: e.message }, { status: 500 });
    }
  } else if (pathname.startsWith('/api/')) {
    res = Response.json({ error: 'not found' }, { status: 404 });
  } else {
    res = await serveStatic(request);
  }
  // Private data: keep it out of search engines and shared caches.
  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  out.headers.set('Cache-Control', 'private, no-store');
  return out;
}
