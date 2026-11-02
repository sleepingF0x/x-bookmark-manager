// Local and CI smoke checks; Node built-ins only, no credentials or dependencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let directory, child, closed, cleanupPromise;
let logs = '';
async function cleanup() {
  return cleanupPromise ??= (async () => {
    if (child) {
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await closed;
      } finally { clearTimeout(force); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  })();
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(signal, () => { cleanup().then(() => process.exit(code), (error) => {
    console.error(error); process.exit(1);
  }); });
}

try {
  directory = await mkdtemp(join(tmpdir(), 'x-bookmark-smoke-'));
  child = spawn(process.execPath, [join(root, 'src/node.js')], {
    cwd: directory,
    // Do not inherit credentials, NODE_OPTIONS, coverage paths, or application settings.
    env: { SITE_PASSWORD: 'smoke-only', DB_PATH: join(directory, 'test.db'), HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  closed = new Promise((resolve) => child.once('close', resolve));
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 15000);
    const finish = (error, url) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve(url);
    };
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => finish(new Error(`Server exited: ${code ?? signal}`)));
    child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-16000); });
    child.stdout.on('data', (chunk) => {
      logs = (logs + chunk).slice(-16000);
      const match = logs.match(/x-bookmark-manager on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) finish(null, match[1]);
    });
  });
  async function request(path, authenticated = false, expected = 200) {
    const response = await fetch(base + path, {
      headers: authenticated ? { Authorization: `Basic ${Buffer.from('test:smoke-only').toString('base64')}` } : {},
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    assert.equal(response.status, expected, path);
    return response;
  }
  assert.deepEqual(await (await request('/healthz')).json(), { ok: true });
  console.log('PASS /healthz');
  for (const path of ['/', '/api/items', '/api/x/status']) {
    const response = await request(path, false, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /^Basic /);
    await response.text();
  }
  console.log('PASS unauthenticated requests return 401');
  const page = await request('/', true);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(await page.text(), await readFile(join(root, 'site/index.html'), 'utf8'));
  console.log('PASS authenticated homepage');
  assert.deepEqual(await (await request('/api/items', true)).json(), { items: [] });
  console.log('PASS /api/items');
  const status = await (await request('/api/x/status', true)).json();
  assert.equal(status.connected, false);
  assert.deepEqual(status.configured, { x: false, llm: false });
  assert.equal(status.pending, 0);
  console.log('PASS /api/x/status');
} catch (error) {
  console.error(error);
  if (logs) console.error('Server output:\n' + logs);
  process.exitCode = 1;
} finally {
  await cleanup();
}
