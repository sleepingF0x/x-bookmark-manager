// Pull bookmarks from X into D1.
// Incremental (default): newest first with full details, starting with a page of 10 and stopping at the
// first page that contains an item already known as bookmarked, so a routine sync costs about 10 reads.
// ?full=1 additionally walks the whole list as bare ids (~1 read per bookmark) to find items removed or
// re-added on X directly; unknown ids found that way are looked up with details.
import { pageToRows } from '../../lib/items.js';
import { BudgetError, acquireLock, getMeta, json, putMeta, releaseLock } from '../../lib/store.js';
import { XError, bookmarkIdsPage, bookmarksPage, credits, lookupPosts } from '../../lib/x.js';

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export async function onRequestPost({ request, env }) {
  const full = new URL(request.url).searchParams.get('full') === '1';
  const user = await getMeta(env, 'x:user');
  if (!user) return json({ error: '尚未连接 X' }, 409);
  if (!(await acquireLock(env, 'sync', 180000))) return json({ error: '另一个同步正在进行' }, 409);
  try {
    const before = await credits(env);
    const known = new Map((await env.DB.prepare('SELECT id, bookmarked FROM items').all()).results.map((r) => [r.id, r.bookmarked]));
    const seen = new Set(); // ids currently bookmarked on X, newest first
    const fresh = new Map(); // id -> row for items not in the library yet
    let error = null, complete = false;
    try {
      let token, size = 10;
      for (let pages = 0; pages < 30; pages++) {
        const page = await bookmarksPage(env, user.id, size, token);
        let hitKnown = false;
        for (const r of pageToRows(page)) {
          seen.add(r.id);
          if (!known.has(r.id)) fresh.set(r.id, r);
          else if (known.get(r.id) === 1) hitKnown = true;
        }
        token = page.meta?.next_token;
        if (!token) { complete = true; break; }
        if (hitKnown) break;
        size = Math.min(100, size * 2);
      }
      if (full && !complete) {
        let token;
        for (let pages = 0; pages < 50; pages++) {
          const page = await bookmarkIdsPage(env, user.id, token);
          for (const p of page.data || []) seen.add(p.id);
          token = page.meta?.next_token;
          if (!token) { complete = true; break; }
        }
        const unknown = [...seen].filter((id) => !known.has(id) && !fresh.has(id));
        for (const ids of chunk(unknown, 100)) for (const r of pageToRows(await lookupPosts(env, ids))) fresh.set(r.id, r);
      }
    } catch (e) {
      // Keep what was fetched before a budget stop or API error; report the reason.
      if (!(e instanceof BudgetError || e instanceof XError)) throw e;
      error = e.message;
    }

    // Accession numbers continue from the newest item, oldest of the new batch first.
    const order = [...seen];
    const added = [...fresh.values()].sort((a, b) => order.indexOf(b.id) - order.indexOf(a.id));
    const { m } = await env.DB.prepare('SELECT COALESCE(MAX(no), 0) AS m FROM items').first();
    const now = new Date().toISOString();
    const stmts = added.map((r, i) => env.DB.prepare(
      'INSERT INTO items (id, no, bookmarked, pending, data, src, added_at) VALUES (?, ?, 1, 1, ?, ?, ?)')
      .bind(r.id, m + 1 + i, JSON.stringify(r.data), r.src, now));
    const back = order.filter((id) => known.get(id) === 0);
    // Removal is only inferred from a complete, error-free walk of the list.
    const gone = full && complete && !error ? [...known].filter(([id, b]) => b === 1 && !seen.has(id)).map(([id]) => id) : [];
    // Re-bookmarking on X counts as "I want this": it also leaves the recycle bin.
    for (const c of chunk(back, 90)) {
      stmts.push(env.DB.prepare(`UPDATE items SET bookmarked = 1, trashed_at = NULL WHERE id IN (${c.map(() => '?').join(',')})`).bind(...c));
    }
    for (const c of chunk(gone, 90)) {
      stmts.push(env.DB.prepare(`UPDATE items SET bookmarked = 0 WHERE id IN (${c.map(() => '?').join(',')})`).bind(...c));
    }
    if (stmts.length) await env.DB.batch(stmts);

    const after = await credits(env);
    const spent = before && after ? +(before.total_balance - after.total_balance).toFixed(4) : null;
    const result = { at: now, full, seen: seen.size, added: added.length, rebookmarked: back.length, removedOnX: gone.length, spent, error };
    await putMeta(env, 'x:lastSync', result);
    const log = (await getMeta(env, 'x:syncLog')) || [];
    await putMeta(env, 'x:syncLog', [result, ...log].slice(0, 30));
    if (after) await putMeta(env, 'x:credits', { ...after, at: Date.now() });
    return json(result, error && !seen.size ? 502 : 200);
  } finally {
    await releaseLock(env, 'sync');
  }
}
