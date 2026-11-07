// The settings panel: GET shows what is in effect and where it comes from (never a key); POST saves.
// Body (every field optional; null clears a saved value so the deployment's variable applies again):
//   {readCap, writeCap, model, llm: {format, baseUrl, apiKey} | null}
// A changed model endpoint or model name is tried with one small request before it is saved, so a
// typo shows up here instead of in the next sync.
import { chat, llmConfigured } from '../lib/llm.js';
import { applySettings, describe, loadSettings, readCap, readLlm, readModel, saveSettings } from '../lib/settings.js';
import { json } from '../lib/store.js';

// `env` has the saved settings applied already; `baseEnv` is the deployment's own environment.
export async function onRequestGet({ env, baseEnv }) {
  return json(describe(baseEnv, await loadSettings(env)));
}

export async function onRequestPost({ request, env, baseEnv }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'invalid json' }, 400);
  const before = await loadSettings(env);
  const next = { ...before };
  for (const [field, read] of [['readCap', readCap], ['writeCap', readCap], ['model', readModel]]) {
    if (!(field in body)) continue;
    const r = read(body[field]);
    if (r.error) return json({ error: r.error }, 400);
    if (r.value === null) delete next[field]; else next[field] = r.value;
  }
  if ('llm' in body) {
    if (body.llm === null) delete next.llm;
    else {
      const r = readLlm(body.llm);
      if (r.error) return json({ error: r.error }, 400);
      next.llm = r.llm;
    }
  }
  const base = baseEnv;
  const was = applySettings(base, before), will = applySettings(base, next);
  const changed = ['LLM_FORMAT', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'].some((k) => (was[k] || '') !== (will[k] || ''));
  if (changed && llmConfigured(will)) {
    try {
      await chat(will, '只回复 JSON。', '回复 {"ok":true}');
    } catch (e) {
      return json({ error: `没有保存：用新的模型设置试连失败（${e.message.slice(0, 200)}）` }, 400);
    }
  }
  await saveSettings(env, next);
  return json(describe(base, next));
}
