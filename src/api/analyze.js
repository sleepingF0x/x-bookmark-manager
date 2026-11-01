// One batch of the "re-analyse" pass: re-judge cleanup (keep/expired/junk) for up to 25 library items
// against today's date with the user's LLM. Items in the bin or marked keep are left alone.
import { readIds, placeholders } from '../lib/ids.js';
import { analyzeCleanup, llmConfigured } from '../lib/llm.js';
import { json } from '../lib/store.js';

export async function onRequestPost({ request, env }) {
  if (!llmConfigured(env)) return json({ error: '未配置模型' }, 409);
  const { ids, error } = await readIds(request, 25);
  if (error) return json({ error }, 400);
  const { results } = await env.DB.prepare(
    `SELECT id, data FROM items WHERE trashed_at IS NULL AND kept = 0 AND pending = 0 AND id IN (${placeholders(ids)})`).bind(...ids).all();
  if (!results.length) return json({ analyzed: 0, changed: [] });
  const items = results.map((r) => JSON.parse(r.data));
  let verdicts;
  try { verdicts = await analyzeCleanup(env, items); } catch (e) { return json({ error: e.message.slice(0, 300) }, 502); }
  const now = new Date().toISOString();
  const changed = [];
  const stmts = items.filter((d) => verdicts[d.id]).map((d) => {
    const v = verdicts[d.id];
    if (v.cleanup !== d.cleanup) changed.push({ id: d.id, from: d.cleanup, to: v.cleanup });
    return env.DB.prepare(`UPDATE items SET data = json_set(data, '$.cleanup', ?, '$.reason', ?, '$.analyzed', ?) WHERE id = ?`)
      .bind(v.cleanup, v.reason, now, d.id);
  });
  if (stmts.length) await env.DB.batch(stmts);
  return json({ analyzed: stmts.length, changed });
}
