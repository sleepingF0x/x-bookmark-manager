// Fallback for when the X API is unavailable: remove bookmarks by clicking each post's own bookmark
// button in the user's Chrome, then verifying the button flipped. The list = items in the site's recycle
// bin that are still bookmarked on X (D1). The first CANARY items act as a live check: any outcome other
// than "removed" stops the run before touching the rest. Removed items are marked in D1 at the end.
// Usage: node scripts/unbookmark.mjs [--dry-run]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const CANARY = 5;

const LOG = new URL('../data/unbookmark-log.json', import.meta.url).pathname;
const dryRun = process.argv.includes('--dry-run');
const d1 = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--remote', '--json', '--command', sql],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0].results;
const ids = d1('SELECT id FROM items WHERE trashed_at IS NOT NULL AND bookmarked = 1 ORDER BY no DESC').map((r) => r.id);
console.log(`${ids.length} items in the recycle bin are still bookmarked on X`);
const log = existsSync(LOG) ? JSON.parse(readFileSync(LOG, 'utf8')) : {};
const todo = ids.filter((id) => log[id] !== 'removed' && log[id] !== 'not-bookmarked');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`${todo.length} to process${dryRun ? ' (dry run)' : ''}`);

const c = await connect();
const { targetId } = await c.send('Target.createTarget', { url: 'about:blank', newWindow: true });
const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
const s = (method, params) => c.send(method, params, sessionId);
await s('Page.enable');
await s('Network.enable');
await s('Emulation.setFocusEmulationEnabled', { enabled: true });

// Watch X's own DeleteBookmark mutation so a rejected request (e.g. rate limit) is seen directly.
const pendingMutations = new Map();
let lastMutation = null;
c.on(async (msg) => {
  if (msg.sessionId !== sessionId) return;
  if (msg.method === 'Network.responseReceived' && /\/DeleteBookmark\b/.test(msg.params.response.url)) {
    pendingMutations.set(msg.params.requestId, msg.params.response.status);
  } else if (msg.method === 'Network.loadingFinished' && pendingMutations.has(msg.params.requestId)) {
    const status = pendingMutations.get(msg.params.requestId);
    pendingMutations.delete(msg.params.requestId);
    let body = '';
    try { body = (await s('Network.getResponseBody', { requestId: msg.params.requestId })).body; } catch {}
    lastMutation = { status, body };
  }
});

// Find the focal tweet's article (the one whose timestamp links to this id) and its bookmark button.
const probe = (id, click) => `(() => {
  const art = [...document.querySelectorAll('article')].find((a) =>
    [...a.querySelectorAll('a[href*="/status/"] time')].some((t) => t.closest('a').href.endsWith('/status/${id}')));
  if (!art) return 'no-article';
  const remove = art.querySelector('[data-testid="removeBookmark"]');
  if (remove) { if (${click}) remove.click(); return 'bookmarked'; }
  return art.querySelector('[data-testid="bookmark"]') ? 'not-bookmarked' : 'no-button';
})()`;
const evaluate = async (expr) => (await s('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

for (const [i, id] of todo.entries()) {
  await s('Page.navigate', { url: `https://x.com/i/status/${id}` });
  let status = 'no-article';
  for (let t = 0; t < 10 && status === 'no-article'; t++) { await sleep(1000); status = await evaluate(probe(id, false)); }
  if (status === 'no-article') {
    // X occasionally fails to render a tweet page under sustained browsing; one reload usually fixes it.
    await s('Page.reload', {});
    for (let t = 0; t < 15 && status === 'no-article'; t++) { await sleep(1000); status = await evaluate(probe(id, false)); }
  }
  let result = status;
  let mutation = null;
  if (status === 'bookmarked' && !dryRun) {
    lastMutation = null;
    await evaluate(probe(id, true));
    result = 'click-unverified';
    for (let t = 0; t < 12; t++) {
      await sleep(500);
      if ((await evaluate(probe(id, false))) === 'not-bookmarked') { result = 'removed'; break; }
    }
    mutation = lastMutation;
    if (mutation && (mutation.status !== 200 || /"errors"/.test(mutation.body))) result = 'rejected';
  }
  if (!dryRun) { log[id] = result; writeFileSync(LOG, JSON.stringify(log, null, 1)); }
  console.log(`[${i + 1}/${todo.length}] ${id} ${result}` +
    (mutation ? ` (DeleteBookmark HTTP ${mutation.status}${/"errors"/.test(mutation.body) ? ' ' + mutation.body.slice(0, 160) : ''})` : status === 'bookmarked' && !dryRun ? ' (no DeleteBookmark request seen)' : ''));
  if (result === 'rejected') {
    console.log('STOPPED: X rejected the request (likely rate limit). Wait before rerunning; finished items are skipped.');
    break;
  }
  if (!dryRun && i < CANARY && result !== 'removed' && result !== 'not-bookmarked') {
    console.log(`STOPPED: canary item ${i + 1} returned "${result}"; nothing after it was touched.`);
    break;
  }
  await sleep(5000);
}

const done = todo.filter((id) => log[id] === 'removed' || log[id] === 'not-bookmarked');
if (!dryRun && done.length) d1(`UPDATE items SET bookmarked = 0 WHERE id IN (${done.map((id) => `'${id}'`).join(',')})`);
await c.send('Target.closeTarget', { targetId });
c.close();
process.exit(0);
