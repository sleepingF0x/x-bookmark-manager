#!/usr/bin/env node
// Node / Docker entry: the same app as the Worker, with SQLite instead of D1 and Workers AI over REST.
// Configuration is environment variables only; see .env.example.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './app.js';
import { workersAI } from './node/ai.js';
import { migrate, openD1 } from './node/d1.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const DB = openD1(process.env.DB_PATH || join(ROOT, 'storage', 'x-bookmarks.db'));
migrate(DB, join(ROOT, 'migrations'));
const env = { ...process.env, DB, AI: workersAI(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_API_TOKEN) };

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
async function serveStatic(request) {
  const path = new URL(request.url).pathname;
  const file = normalize(join(SITE, path === '/' ? 'index.html' : decodeURIComponent(path)));
  if (!file.startsWith(SITE)) return new Response('Not Found', { status: 404 });
  try {
    return new Response(await readFile(file), { headers: { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' } });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

// The public origin matters for the X OAuth redirect URI: behind a TLS proxy the app sees plain http,
// so PUBLIC_URL (or X-Forwarded-Proto) supplies the scheme and host X will redirect back to.
function origin(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const request = new Request(origin(req) + req.url, {
      method: req.method, headers, body: chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined,
    });
    const response = await handle(request, env, serveStatic);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Internal Server Error');
  }
}).listen(PORT, HOST, () => console.log(`x-bookmark-manager on http://${HOST}:${PORT}`));
