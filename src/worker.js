// Cloudflare Workers entry. wrangler.jsonc sets assets.run_worker_first so the password check
// runs before any static file is served.
import { handle } from './app.js';

export default {
  fetch: (request, env) => handle(request, env, (req) => env.ASSETS.fetch(req)),
};
