// Label + embed the next few pending items. The site calls this repeatedly after a sync.
import { processPending } from '../../lib/items.js';
import { acquireLock, json, releaseLock } from '../../lib/store.js';

export async function onRequestPost({ env }) {
  if (!(await acquireLock(env, 'process', 180000))) return json({ error: '正在整理中' }, 409);
  try {
    const r = await processPending(env, 10);
    const left = await env.DB.prepare('SELECT count(*) AS n FROM items WHERE pending = 1').first();
    return json({ ...r, remaining: left.n });
  } catch (e) {
    return json({ error: e.message }, 502);
  } finally {
    await releaseLock(env, 'process');
  }
}
