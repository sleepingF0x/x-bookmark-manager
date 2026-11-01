// Permanently delete items from the recycle bin. Body {ids}. Only items already off the X bookmark
// list are deleted; anything still bookmarked would just come back on the next full sync.
import { readIds, placeholders } from '../../lib/ids.js';
import { json } from '../../lib/store.js';

export async function onRequestPost({ request, env }) {
  const { ids, error } = await readIds(request, 1000);
  if (error) return json({ error }, 400);
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 90) {
    const c = ids.slice(i, i + 90);
    const r = await env.DB.prepare(`DELETE FROM items WHERE trashed_at IS NOT NULL AND bookmarked = 0 AND id IN (${placeholders(c)})`).bind(...c).run();
    deleted += r.meta.changes;
  }
  return json({ deleted, skipped: ids.length - deleted });
}
