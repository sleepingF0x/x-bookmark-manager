// Move items to the recycle bin and remove them from X bookmarks ($0.005 each). Body {ids} (<= 20).
// The bin entry is written first, so an X failure leaves the item in the bin marked "still on X"
// and calling this again retries the X removal.
import { readIds, placeholders } from '../../lib/ids.js';
import { BudgetError, getMeta, json } from '../../lib/store.js';
import { XError, removeBookmark } from '../../lib/x.js';

export async function onRequestPost({ request, env }) {
  const { ids, error } = await readIds(request, 20);
  if (error) return json({ error }, 400);
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE items SET trashed_at = ? WHERE trashed_at IS NULL AND id IN (${placeholders(ids)})`).bind(now, ...ids).run();
  const { results } = await env.DB.prepare(`SELECT id FROM items WHERE bookmarked = 1 AND id IN (${placeholders(ids)})`).bind(...ids).all();
  const user = await getMeta(env, 'x:user');
  const removed = [], failed = [];
  let stopped = results.length && !user ? '尚未连接 X，已放入回收站但未从 X 移除' : null;
  for (const { id } of stopped ? [] : results) {
    try {
      if (await removeBookmark(env, user.id, id)) {
        removed.push(id);
        await env.DB.prepare('UPDATE items SET bookmarked = 0 WHERE id = ?').bind(id).run();
      } else failed.push(id);
    } catch (e) {
      if (e instanceof BudgetError || (e instanceof XError && [401, 403, 429].includes(e.status))) { stopped = e.message; break; }
      if (!(e instanceof XError)) throw e;
      failed.push(id);
    }
  }
  return json({ trashed: ids, removed, failed, stopped });
}
