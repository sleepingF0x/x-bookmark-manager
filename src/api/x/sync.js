// Pull bookmarks from X into D1.
// Incremental (default): newest first with full details, starting with a page of 10 and stopping at the
// first page that contains an item already known as bookmarked, so a routine sync costs about 10 reads.
// ?full=1 additionally walks the whole list as bare ids (~1 read per bookmark) to find items removed or
// re-added on X directly; unknown ids found that way are looked up with details.
// After a complete full check, library items missing from the list follow the user's cleanup: X is asked
// which of those posts still exist (one cheap lookup per item, once). Still there → the user removed the
// bookmark → recycle bin. Gone (deleted, protected, suspended) → stays in the library marked unavailable,
// since it may be the only copy. Only a complete walk proves an item is off the list: a bookmarked = 0 from
// an older version or the local import may be wrong, and such items are simply marked bookmarked again.
// X's list can also end early without saying so (seen in practice: ~200 of ~700 bookmarks, no error). The
// list is newest first, so removal is only inferred for items bookmarked after the oldest one it returned;
// anything older is out of reach and left exactly as it is.
import { pageToRows } from '../../lib/items.js';
import { BudgetError, acquireLock, getMeta, json, putMeta, releaseLock } from '../../lib/store.js';
import { XError, bookmarkIdsPage, bookmarksPage, credits, lookupPosts, visiblePosts } from '../../lib/x.js';

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export async function onRequestPost({ request, env }) {
  const full = new URL(request.url).searchParams.get('full') === '1';
  const user = await getMeta(env, 'x:user');
  if (!user) return json({ error: '尚未连接 X' }, 409);
  if (!(await acquireLock(env, 'sync', 180000))) return json({ error: '另一个同步正在进行' }, 409);
  try {
    const before = await credits(env);
    const { results: rows } = await env.DB.prepare(
      `SELECT id, no, bookmarked, trashed_at IS NOT NULL AS trashed, json_extract(data, '$.unavailable') IS NOT NULL AS unavailable FROM items`).all();
    const known = new Map(rows.map((r) => [r.id, r.bookmarked]));
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
    // The oldest library item the list reached: a missing item numbered above it would have appeared before it.
    // (Accession numbers follow bookmark order; a re-bookmarked old item sits near the top, never last.)
    const noById = new Map(rows.map((r) => [r.id, r.no]));
    const walked = full && complete && !error;
    const lastKnown = walked ? order.findLast((id) => noById.has(id)) : undefined;
    const floor = lastKnown === undefined ? Infinity : noById.get(lastKnown);
    const inReach = (r) => !seen.has(r.id) && r.no > floor;
    const gone = rows.filter((r) => r.bookmarked === 1 && inReach(r)).map((r) => r.id);
    const beyondReach = walked ? rows.filter((r) => r.bookmarked === 1 && !seen.has(r.id) && r.no < floor).length : 0;
    // Re-bookmarking on X counts as "I want this": it also leaves the recycle bin.
    for (const c of chunk(back, 90)) {
      stmts.push(env.DB.prepare(`UPDATE items SET bookmarked = 1, trashed_at = NULL WHERE id IN (${c.map(() => '?').join(',')})`).bind(...c));
    }
    for (const c of chunk(gone, 90)) {
      stmts.push(env.DB.prepare(`UPDATE items SET bookmarked = 0 WHERE id IN (${c.map(() => '?').join(',')})`).bind(...c));
    }

    // In the library but, per a complete walk, not on the X list: just removed, or off X since earlier.
    const offX = rows.filter((r) => !r.trashed && !r.unavailable && inReach(r)).map((r) => r.id);
    const toBin = [], unavailable = [];
    try {
      for (const ids of chunk(offX, 100)) {
        const { visible, missing } = await visiblePosts(env, ids);
        for (const id of ids) if (visible.has(id)) toBin.push(id); else if (missing.has(id)) unavailable.push(id);
      }
    } catch (e) {
      // Whatever was not checked stays as it is and is checked on the next sync.
      if (!(e instanceof BudgetError || e instanceof XError)) throw e;
      error = error || e.message;
    }
    for (const c of chunk(toBin, 90)) {
      stmts.push(env.DB.prepare(`UPDATE items SET trashed_at = ? WHERE trashed_at IS NULL AND id IN (${c.map(() => '?').join(',')})`).bind(now, ...c));
    }
    for (const c of chunk(unavailable, 90)) {
      stmts.push(env.DB.prepare(`UPDATE items SET data = json_set(data, '$.unavailable', ?) WHERE id IN (${c.map(() => '?').join(',')})`).bind(now, ...c));
    }
    if (stmts.length) await env.DB.batch(stmts);

    const after = await credits(env);
    const spent = before && after ? +(before.total_balance - after.total_balance).toFixed(4) : null;
    const result = { at: now, full, seen: seen.size, added: added.length, rebookmarked: back.length, removedOnX: gone.length,
      binned: toBin.length, unavailable: unavailable.length, unresolved: offX.length - toBin.length - unavailable.length, beyondReach, spent, error };
    await putMeta(env, 'x:lastSync', result);
    const log = (await getMeta(env, 'x:syncLog')) || [];
    await putMeta(env, 'x:syncLog', [result, ...log].slice(0, 30));
    if (after) await putMeta(env, 'x:credits', { ...after, at: Date.now() });
    return json(result, error && !seen.size ? 502 : 200);
  } finally {
    await releaseLock(env, 'sync');
  }
}
