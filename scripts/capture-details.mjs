// Visit tweet pages in the user's own Chrome and save the TweetDetail GraphQL response for each
// (includes X Article full content and the author's thread replies). Read-only, skips ids already saved.
// Usage: node scripts/capture-details.mjs <ids.json>   (array of {id, handle})
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const OUT = new URL('../data/raw/details/', import.meta.url).pathname;
const OP_RE = /\/graphql\/[^/]+\/(TweetDetail|TweetResultByRestId)\b/;
const PAGE_WAIT_MS = 6000;
const GAP_MS = 3000; // polite pacing between pages

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const todo = JSON.parse(readFileSync(process.argv[2], 'utf8')).filter((t) => !existsSync(`${OUT}${t.id}.json`));
console.log(`${todo.length} to capture`);

const c = await connect();
const { targetId } = await c.send('Target.createTarget', { url: 'about:blank', newWindow: true });
const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
const s = (method, params) => c.send(method, params, sessionId);
await s('Network.enable');
await s('Page.enable');
await s('Emulation.setFocusEmulationEnabled', { enabled: true });

const tracked = new Set();
let captured = [];
c.on(async (msg) => {
  if (msg.sessionId !== sessionId) return;
  if (msg.method === 'Network.responseReceived' && OP_RE.test(msg.params.response.url)) {
    tracked.add(msg.params.requestId);
  } else if (msg.method === 'Network.loadingFinished' && tracked.delete(msg.params.requestId)) {
    try {
      const { body, base64Encoded } = await s('Network.getResponseBody', { requestId: msg.params.requestId });
      captured.push(JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body));
    } catch {}
  }
});

let ok = 0, failed = [];
for (const [i, { id, handle }] of todo.entries()) {
  captured = [];
  await s('Page.navigate', { url: `https://x.com/${handle ?? 'i'}/status/${id}` });
  await sleep(PAGE_WAIT_MS);
  // One scroll pulls in more of the author's self-replies for threads.
  await s('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body.scrollHeight)' });
  await sleep(2000);
  if (captured.length) {
    writeFileSync(`${OUT}${id}.json`, JSON.stringify(captured));
    ok++;
  } else {
    failed.push(id);
  }
  console.log(`[${i + 1}/${todo.length}] ${id} ${captured.length ? 'ok' : 'NO DATA'}`);
  await sleep(GAP_MS);
}

console.log(`done: ${ok} ok, ${failed.length} failed`, failed);
await c.send('Target.closeTarget', { targetId });
c.close();
process.exit(0);
