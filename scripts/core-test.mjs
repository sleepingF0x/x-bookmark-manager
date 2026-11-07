// Checks for the paths that spend money or change bookmarks on X: cross-site request refusal, the LLM
// client's token-limit fallback, labelling that cannot get stuck on one bad item, and sync
// reconciliation with X. Runs the real app (src/app.js) in-process on a throwaway SQLite database,
// with X, the LLM endpoint and Workers AI stubbed. Node built-ins only; no network or credentials.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/app.js';
import { MAX_LABEL_ATTEMPTS } from '../src/lib/items.js';
import { migrate, openD1 } from '../src/node/d1.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'x-bookmark-core-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

// ---------- stubs ----------
// X: `list` is the user's bookmark list, newest first. Posts whose id is in `poison` carry text the
// fake LLM refuses; ids in `skip` are left out of the model's replies.
let x, llm, dbN = 0;
const post = (id) => ({ id, text: `${llm.poison.has(id) ? 'POISON ' : ''}${llm.skip.has(id) ? 'SKIP ' : ''}post ${id}`,
  author_id: 'a1', created_at: '2026-01-01T00:00:00.000Z' });
const page = (ids, full) => ({
  data: ids.map((id) => (full ? post(id) : { id })),
  ...(full ? { includes: { users: [{ id: 'a1', username: 'alice', name: 'Alice' }] } } : {}),
});

function fakeX(url, init) {
  const method = init?.method || 'GET';
  const path = url.pathname;
  if (path === '/2/usage/credits') return Response.json({ data: { total_balance: 10 } });
  let m;
  if ((m = path.match(/^\/2\/users\/U\/bookmarks\/(\d+)$/)) && method === 'DELETE') {
    x.list = x.list.filter((id) => id !== m[1]);
    return Response.json({ data: { bookmarked: false } });
  }
  if (path === '/2/users/U/bookmarks' && method === 'POST') {
    x.list.unshift(JSON.parse(init.body).tweet_id);
    return Response.json({ data: { bookmarked: true } });
  }
  if (path === '/2/users/U/bookmarks') {
    const q = url.searchParams, n = +q.get('max_results'), at = +(q.get('pagination_token') || 0);
    const ids = x.list.slice(at, at + n);
    x.pages++;
    return Response.json({ ...page(ids, q.has('post.fields')), meta: at + n < x.list.length ? { next_token: String(at + n) } : {} });
  }
  if (path === '/2/tweets') return Response.json(page(url.searchParams.get('ids').split(','), true));
  return new Response('unexpected X call ' + method + ' ' + path, { status: 500 });
}

// The LLM endpoint, OpenAI style. `mode`: ok | 401 (bad key) | 400 (e.g. unknown model, every call).
// `reasoning`: behaves like OpenAI's reasoning models and rejects max_tokens.
const HEALTH = '回复 {"ok":true}';
function fakeLLM(init) {
  const body = JSON.parse(init.body);
  llm.calls.push(body);
  if (llm.mode === '401') return new Response('{"error":"invalid api key"}', { status: 401 });
  if (llm.mode === '400') return new Response('{"error":"Model Not Exist"}', { status: 400 });
  if (llm.maxOut && (body.max_tokens ?? body.max_completion_tokens) > llm.maxOut) {
    return new Response(`{"error":"max_tokens is too large: this model supports at most ${llm.maxOut}"}`, { status: 400 });
  }
  if (llm.reasoning && 'max_tokens' in body) {
    return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }), { status: 400 });
  }
  const user = body.messages.at(-1).content;
  const reply = (content) => Response.json({ choices: [{ message: { content } }] });
  if (user === HEALTH) return reply('{"ok":true}');
  if (user.includes('POISON')) return new Response('{"error":"Content Exists Risk"}', { status: 400 });
  const ids = [...user.matchAll(/<item id="(\d+)">\n([^\n]*\n)?([\s\S]*?)<\/item>/g)].filter((m) => !m[0].includes('SKIP')).map((m) => m[1]);
  // Ids as bare numbers, as models often write them.
  return reply('好的：\n{"items":[' + ids.map((id) => `{"id":${id},"category":"开发与开源工具","tags":["工具"],"type":"工具/项目","title":"标题${id}","summary":"摘要","score":4,"cleanup":"keep","cleanup_reason":""}`).join(',') + ']}');
}

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.host === 'api.x.com') return fakeX(url, init);
  if (url.host === 'llm.test') return fakeLLM(init);
  throw new TypeError('unexpected fetch ' + url);
};

// ---------- app harness ----------
function fresh({ env: extra = {}, list = [], connected = true } = {}) {
  x = { list: [...list], pages: 0 };
  llm = { mode: 'ok', reasoning: false, maxOut: 0, poison: new Set(), skip: new Set(), calls: [] };
  const DB = openD1(join(tmp, `t${++dbN}.db`));
  migrate(DB, join(root, 'migrations'));
  const AI = { run: async (_m, { text }) => ({ data: text.map(() => [0.5, 0.5, 0.5, 0.5]) }) };
  const env = { DB, AI, SITE_PASSWORD: 'pw', X_CLIENT_ID: 'c', X_CLIENT_SECRET: 's',
    LLM_BASE_URL: 'https://llm.test/v1', LLM_API_KEY: 'k', LLM_MODEL: `model-${dbN}`, ...extra };
  if (connected) {
    DB.raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?), (?, ?)').run(
      'x:token', JSON.stringify({ access: 'A', refresh: 'R', exp: Date.now() + 3600e3 }), 'x:user', JSON.stringify({ id: 'U', username: 'me' }));
  }
  const call = async (method, path, { body, headers = {} } = {}) => {
    const res = await handle(new Request('https://app.test' + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: 'Basic ' + btoa('anyone:pw'), 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
      redirect: 'manual',
    }), env, () => new Response('static'));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  const rows = () => DB.raw.prepare('SELECT id, no, bookmarked, pending, trashed_at, data FROM items ORDER BY no').all()
    .map((r) => ({ ...r, data: JSON.parse(r.data) }));
  const meta = (k) => { const r = DB.raw.prepare('SELECT value FROM meta WHERE key = ?').get(k); return r ? JSON.parse(r.value) : null; };
  return { env, call, rows, meta, DB };
}

// Same loop as processAll() in site/index.html.
async function processAll(app) {
  let last;
  for (let k = 0; k < 60; k++) {
    last = await app.call('POST', '/api/x/process');
    const j = last.json;
    if (last.status !== 200 || !j.processed || (!j.labelled && !j.failed) || !j.remaining) break;
  }
  return last;
}

const ids = (n, from = 1) => Array.from({ length: n }, (_, i) => String(1000000000000000000n + BigInt(from + i)));
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ---------- cross-site requests ----------
test('form-style text/plain POST is refused before it changes anything', async () => {
  const app = fresh();
  app.DB.raw.prepare("INSERT INTO items (id, no, data, added_at) VALUES ('5', 1, '{}', 'x')").run();
  const r = await app.call('POST', '/api/keep', { headers: { 'Content-Type': 'text/plain' }, body: { ids: ['5'] } });
  assert.equal(r.status, 415);
  assert.equal(app.DB.raw.prepare("SELECT kept FROM items WHERE id = '5'").get().kept, 0);
  assert.equal((await app.call('POST', '/api/x/sync', { headers: { 'Content-Type': '' } })).status, 415);
});
test('API calls another site started are refused, GET included', async () => {
  const app = fresh();
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await app.call('POST', '/api/keep', { headers: { 'Sec-Fetch-Site': site }, body: { ids: ['5'] } })).status, 403);
    assert.equal((await app.call('GET', '/api/x/llmcheck?compare=5', { headers: { 'Sec-Fetch-Site': site } })).status, 403);
  }
});
test('same-origin JSON, typed URLs, pages and the OAuth callback still work', async () => {
  const app = fresh();
  app.DB.raw.prepare("INSERT INTO items (id, no, data, added_at) VALUES ('5', 1, '{}', 'x')").run();
  assert.equal((await app.call('POST', '/api/keep', { body: { ids: ['5'] }, headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status, 200);
  assert.equal((await app.call('GET', '/api/items', { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200);
  assert.equal((await app.call('GET', '/api/items', { headers: { 'Sec-Fetch-Site': '' } })).status, 200); // browsers that omit it
  assert.equal((await app.call('GET', '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).text, 'static'); // a link to the site
  const cb = await app.call('GET', '/api/x/callback?state=s&code=c', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cb.status, 302); // redirected back from x.com, not refused
});

// ---------- LLM client ----------
test('reasoning models: switches to max_completion_tokens once and remembers it', async () => {
  const app = fresh();
  llm.reasoning = true;
  const first = await app.call('GET', '/api/x/llmcheck');
  assert.equal(first.json.ok, true, first.text);
  assert.deepEqual(llm.calls.map((b) => 'max_tokens' in b), [true, false]);
  await app.call('GET', '/api/x/llmcheck');
  assert.equal('max_tokens' in llm.calls.at(-1), false);
  assert.equal(llm.calls.length, 3);
});
test('other endpoints keep max_tokens', async () => {
  const app = fresh();
  assert.equal((await app.call('GET', '/api/x/llmcheck')).json.ok, true);
  assert.deepEqual(llm.calls.map((b) => 'max_tokens' in b), [true]);
});

// ---------- labelling ----------
test('one item the model refuses no longer blocks the queue', async () => {
  const list = ids(25);
  const app = fresh({ list });
  llm.poison.add(list[0]); // the newest bookmark: first in every batch
  assert.equal((await app.call('POST', '/api/x/sync')).json.added, 25);
  const last = await processAll(app);
  assert.equal(last.json.remaining, 0, last.text);
  const rows = app.rows();
  assert.ok(rows.every((r) => r.pending === 0));
  const bad = rows.find((r) => r.id === list[0]);
  assert.equal(bad.data.category, '未分类');
  assert.match(bad.data.labelError, /400/);
  assert.ok(rows.filter((r) => r.id !== list[0]).every((r) => r.data.category === '开发与开源工具' && r.data.title.startsWith('标题')));
  assert.deepEqual(app.meta('process:failures'), {});
});
test('an item the model keeps leaving out is given up after a few rounds, the rest labelled', async () => {
  const list = ids(3);
  const app = fresh({ list });
  llm.skip.add(list[1]);
  await app.call('POST', '/api/x/sync');
  for (let k = 1; k < MAX_LABEL_ATTEMPTS; k++) {
    const r = await app.call('POST', '/api/x/process');
    assert.equal(r.json.remaining, 1);
    assert.equal(app.meta('process:failures')[list[1]], k);
  }
  const r = await app.call('POST', '/api/x/process');
  assert.deepEqual([r.json.gaveUp, r.json.remaining], [1, 0]);
  assert.ok(app.rows().find((x) => x.id === list[1]).data.labelError);
});
test('a bad key stops processing without counting failures', async () => {
  const app = fresh({ list: ids(5) });
  await app.call('POST', '/api/x/sync');
  llm.mode = '401';
  for (let k = 0; k < MAX_LABEL_ATTEMPTS + 1; k++) assert.equal((await app.call('POST', '/api/x/process')).status, 502);
  assert.ok(app.rows().every((r) => r.pending === 1 && !r.data.labelError));
  assert.equal(app.meta('process:failures'), null);
});
test('a 400 on every request (e.g. unknown model) is not blamed on the items', async () => {
  const app = fresh({ list: ids(5) });
  await app.call('POST', '/api/x/sync');
  llm.mode = '400';
  for (let k = 0; k < MAX_LABEL_ATTEMPTS + 1; k++) assert.equal((await app.call('POST', '/api/x/process')).status, 502);
  assert.ok(app.rows().every((r) => r.pending === 1 && !r.data.labelError));
  llm.mode = 'ok';
  assert.equal((await processAll(app)).json.remaining, 0);
  assert.ok(app.rows().every((r) => r.pending === 0 && !r.data.labelError));
});
test('a token limit the model does not allow is not blamed on the items either', async () => {
  const app = fresh({ list: ids(3) });
  await app.call('POST', '/api/x/sync');
  llm.maxOut = 2048;
  assert.equal((await app.call('GET', '/api/x/llmcheck')).json.ok, false); // the diagnostic shows it too
  for (let k = 0; k < MAX_LABEL_ATTEMPTS + 1; k++) assert.equal((await app.call('POST', '/api/x/process')).status, 502);
  assert.ok(app.rows().every((r) => r.pending === 1 && !r.data.labelError));
});

// ---------- sync with X ----------
test('first sync imports everything, oldest bookmark gets no 1', async () => {
  const list = ids(25);
  const app = fresh({ list });
  const r = await app.call('POST', '/api/x/sync');
  assert.equal(r.json.added, 25);
  const rows = app.rows();
  assert.deepEqual(rows.map((x) => x.id), [...list].reverse());
  assert.ok(rows.every((x) => x.pending === 1 && x.bookmarked === 1));
});
test('incremental sync stops at the first known bookmark', async () => {
  const list = ids(40);
  const app = fresh({ list });
  await app.call('POST', '/api/x/sync');
  const pagesBefore = x.pages;
  x.list.unshift(...ids(2, 100));
  const r = await app.call('POST', '/api/x/sync');
  assert.equal(r.json.added, 2);
  assert.equal(x.pages - pagesBefore, 1);
  assert.equal(app.rows().at(-1).id, ids(1, 100)[0]); // newest bookmark has the highest number
});
test('full check: removed on X, re-bookmarked on X (leaves the bin), new', async () => {
  const list = ids(30);
  const app = fresh({ list });
  await app.call('POST', '/api/x/sync');
  const [binned, gone1, gone2] = [list[5], list[20], list[25]];
  const t = await app.call('POST', '/api/trash', { body: { ids: [binned] } });
  assert.deepEqual(t.json.removed, [binned]);
  x.list = x.list.filter((id) => id !== gone1 && id !== gone2);
  x.list.unshift(binned, ...ids(1, 200)); // re-bookmarked directly on X, plus a new one
  const r = await app.call('POST', '/api/x/sync?full=1');
  assert.deepEqual([r.json.added, r.json.rebookmarked, r.json.removedOnX, r.json.error], [1, 1, 2, null], r.text);
  const by = new Map(app.rows().map((x) => [x.id, x]));
  assert.equal(by.get(binned).bookmarked, 1);
  assert.equal(by.get(binned).trashed_at, null);
  assert.equal(by.get(gone1).bookmarked, 0);
  assert.equal(by.get(gone2).bookmarked, 0);
});
test('a full check cut short by the read cap infers no removals', async () => {
  const list = ids(150);
  const app = fresh({ list });
  await app.call('POST', '/api/x/sync');
  x.list = x.list.filter((id) => id !== list[140]);
  const used = app.meta(`usage:${new Date().toISOString().slice(0, 7)}:reads`);
  app.env.X_MONTHLY_READ_CAP = String(used + 140); // room for the incremental page and one id page, not two
  const r = await app.call('POST', '/api/x/sync?full=1');
  assert.match(r.json.error, /上限/);
  assert.equal(r.json.removedOnX, 0);
  assert.ok(app.rows().every((x) => x.bookmarked === 1));
});

let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.error('FAIL', name, '\n', e); }
}
if (failed) process.exitCode = 1;
