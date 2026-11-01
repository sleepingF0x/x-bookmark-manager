// Take items out of the recycle bin: they return to the library, are marked "keep" so analysis won't
// flag them again, and are bookmarked on X again if they had been removed there. Body {ids} (<= 20).
import { readIds, placeholders } from '../lib/ids.js';
import { BudgetError, getMeta, json } from '../lib/store.js';
import { XError, addBookmark } from '../lib/x.js';

export async function onRequestPost({ request, env }) {
  const { ids, error } = await readIds(request, 20);
  if (error) return json({ error }, 400);
  await env.DB.prepare(`UPDATE items SET trashed_at = NULL, kept = 1 WHERE id IN (${placeholders(ids)})`).bind(...ids).run();
  const { results } = await env.DB.prepare(`SELECT id FROM items WHERE bookmarked = 0 AND id IN (${placeholders(ids)})`).bind(...ids).all();
  const user = await getMeta(env, 'x:user');
  const rebookmarked = [], failed = [];
  let stopped = results.length && !user ? '尚未连接 X，已恢复到知识库但未重新收藏' : null;
  for (const { id } of stopped ? [] : results) {
    try {
      if (await addBookmark(env, user.id, id)) {
        rebookmarked.push(id);
        await env.DB.prepare('UPDATE items SET bookmarked = 1 WHERE id = ?').bind(id).run();
      } else failed.push(id);
    } catch (e) {
      if (e instanceof BudgetError || (e instanceof XError && [401, 403, 429].includes(e.status))) { stopped = e.message; break; }
      if (!(e instanceof XError)) throw e;
      failed.push(id); // e.g. the post was deleted on X
    }
  }
  return json({ restored: ids, rebookmarked, failed, stopped });
}
