// Diagnostic: one tiny round trip to the configured LLM, so a bad URL/key/model shows up before a sync needs it.
// ?models=1 lists the model ids the endpoint offers (OpenAI-style GET /models).
import { chat, classify, llmConfigured } from '../../lib/llm.js';

// ?compare=N re-labels N random already-labelled items and returns old vs new labels side by side,
// to judge whether the configured model labels like the one that built the library.
async function compare(env, n) {
  const { results } = await env.DB.prepare('SELECT id, data FROM items WHERE pending = 0 ORDER BY random() LIMIT ?').bind(n).all();
  const rows = results.map((r) => {
    const d = JSON.parse(r.data);
    return { id: r.id, data: d, src: `@${d.handle} ${d.date}\n${[d.body, d.quote?.body, d.article?.title].filter(Boolean).join('\n')}`.slice(0, 1500) };
  });
  const t = Date.now();
  const labels = await classify(env, rows, []);
  return Response.json({
    model: env.LLM_MODEL, ms: Date.now() - t, returned: Object.keys(labels).length,
    rejected: labels.raw.filter((x) => !labels[String(x.id)]).map((x) => ({ id: x.id, category: x.category, type: x.type })),
    missingIds: rows.filter((r) => !labels.raw.some((x) => String(x.id) === r.id)).map((r) => r.id),
    items: rows.map((r) => {
      const n = labels[r.id];
      return { id: r.id, old: [r.data.category, r.data.type, r.data.score, r.data.cleanup, r.data.title],
        new: n ? [n.category, n.type, n.score, n.cleanup, n.title] : null };
    }),
  });
}

async function listModels(env) {
  const base = env.LLM_BASE_URL.replace(/\/+$/, '');
  const anthropic = (env.LLM_FORMAT || (/anthropic/i.test(base) ? 'anthropic' : 'openai')) === 'anthropic';
  const r = await fetch(`${base}${anthropic && !/\/v1$/.test(base) ? '/v1' : ''}/models`, {
    headers: anthropic ? { 'x-api-key': env.LLM_API_KEY, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${env.LLM_API_KEY}` },
  });
  if (!r.ok) return Response.json({ ok: false, error: `GET /models ${r.status}: ${(await r.text()).slice(0, 300)}` });
  const { data } = await r.json();
  return Response.json({ ok: true, current: env.LLM_MODEL, models: (data || []).map((m) => m.id) });
}

export async function onRequestGet({ request, env }) {
  if (!llmConfigured(env)) return Response.json({ ok: false, error: '未配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL' });
  const q = new URL(request.url).searchParams;
  if (q.get('models')) return listModels(env);
  if (q.get('compare')) return compare(env, Math.min(20, +q.get('compare') || 10));
  const t = Date.now();
  try {
    // The same token limit as labelling: room for a reasoning model's thinking (50 left those with an
    // empty reply), and a limit the model does not allow shows up here rather than in the first sync.
    const out = await chat(env, '只回复 JSON。', '回复 {"ok":true}');
    return Response.json({ ok: /"ok"\s*:\s*true/.test(out), model: env.LLM_MODEL, ms: Date.now() - t, reply: out.slice(0, 100) });
  } catch (e) {
    return Response.json({ ok: false, model: env.LLM_MODEL, error: e.message.slice(0, 300) });
  }
}
