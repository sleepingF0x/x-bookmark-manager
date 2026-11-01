// Mark cleanup candidates as "keep": they leave the cleanup list and analysis skips them from now on.
// Body {ids, kept?: false} (false clears the mark).
import { readIds, placeholders } from '../lib/ids.js';
import { json } from '../lib/store.js';

export async function onRequestPost({ request, env }) {
  const { ids, body, error } = await readIds(request, 1000);
  if (error) return json({ error }, 400);
  const flag = body.kept === false ? 0 : 1;
  for (let i = 0; i < ids.length; i += 90) {
    const c = ids.slice(i, i + 90);
    await env.DB.prepare(`UPDATE items SET kept = ? WHERE id IN (${placeholders(c)})`).bind(flag, ...c).run();
  }
  return json({ ids, kept: Boolean(flag) });
}
