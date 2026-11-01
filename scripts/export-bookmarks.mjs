// Export X bookmarks (and Premium bookmark folders) by driving the user's own logged-in Chrome
// and saving the raw GraphQL responses X's web app receives. Read-only: never clicks or posts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';

const OUT = new URL(`../data/raw/${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url).pathname;
const SCROLL_DELAY_MS = 2500;
const IDLE_ROUNDS_TO_STOP = 6; // ~15s with no new bookmark responses => assume the end
const OP_RE = /\/graphql\/[^/]+\/(Bookmarks|BookmarkFolderTimeline|BookmarkFoldersSlice)\b/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const c = await connect();
const { targetId } = await c.send('Target.createTarget', { url: 'about:blank', newWindow: true });
const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
const s = (method, params) => c.send(method, params, sessionId);

await s('Network.enable');
await s('Page.enable');
await s('Emulation.setFocusEmulationEnabled', { enabled: true }); // keep timers alive if window loses focus

const tracked = new Map(); // requestId -> op
const saved = [];
let seq = 0;
let currentScope = 'all';
let lastCaptureAt = Date.now();

c.on(async (msg) => {
  if (msg.sessionId !== sessionId) return;
  if (msg.method === 'Network.responseReceived') {
    const m = msg.params.response.url.match(OP_RE);
    if (m) tracked.set(msg.params.requestId, m[1]);
  } else if (msg.method === 'Network.loadingFinished' && tracked.has(msg.params.requestId)) {
    const op = tracked.get(msg.params.requestId);
    tracked.delete(msg.params.requestId);
    try {
      const { body, base64Encoded } = await s('Network.getResponseBody', { requestId: msg.params.requestId });
      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
      const json = JSON.parse(text);
      const file = `${String(++seq).padStart(4, '0')}-${op}-${currentScope}.json`;
      writeFileSync(OUT + file, JSON.stringify(json));
      saved.push({ op, scope: currentScope, json });
      lastCaptureAt = Date.now();
      console.log(`  saved ${file} (+${countTweets(json)} tweets)`);
    } catch (e) {
      console.log(`  failed to read ${op}: ${e.message}`);
    }
  }
});

function countTweets(json) {
  let n = 0;
  JSON.stringify(json, (k, v) => {
    if (k === 'entryId' && typeof v === 'string' && v.startsWith('tweet-')) n++;
    return v;
  });
  return n;
}

function findFolders() {
  const folders = new Map();
  for (const { op, json } of saved) {
    if (op !== 'BookmarkFoldersSlice') continue;
    const items = json?.data?.viewer?.user_results?.result?.bookmark_collections_slice?.items ?? [];
    for (const it of items) if (it?.id) folders.set(it.id, it.name);
  }
  return folders;
}

async function scrapeTimeline(url, scope) {
  currentScope = scope;
  console.log(`\n== ${scope}: ${url}`);
  await s('Page.navigate', { url });
  await sleep(5000);
  lastCaptureAt = Date.now();
  while (Date.now() - lastCaptureAt < IDLE_ROUNDS_TO_STOP * SCROLL_DELAY_MS) {
    await s('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body.scrollHeight)' });
    await sleep(SCROLL_DELAY_MS);
  }
}

await scrapeTimeline('https://x.com/i/bookmarks', 'all');
if (!saved.some((x) => x.op === 'Bookmarks')) {
  // X sometimes withholds data (e.g. rate limiting after heavy browsing); an empty run is not "no bookmarks".
  console.log('FAILED: no Bookmarks responses captured. X may be rate limiting; wait ~15 minutes and retry.');
  await c.send('Target.closeTarget', { targetId });
  process.exit(1);
}

const folders = findFolders();
console.log(`\nfolders found: ${folders.size}`, [...folders.values()]);
for (const [id, name] of folders) {
  await scrapeTimeline(`https://x.com/i/bookmarks/${id}`, `folder_${id}`);
}

writeFileSync(OUT + 'folders.json', JSON.stringify(Object.fromEntries(folders), null, 2));
const totals = {};
for (const { scope, json } of saved) totals[scope] = (totals[scope] ?? 0) + countTweets(json);
console.log('\nDONE. output dir:', OUT);
console.log('tweet entries per scope:', totals);

await c.send('Target.closeTarget', { targetId });
c.close();
process.exit(0);
