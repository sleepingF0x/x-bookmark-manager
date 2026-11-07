// Model ids for the settings panel's model picker. Body {llm?: {format, baseUrl, apiKey}}: the endpoint
// being entered, or the one in effect when omitted. An address is only ever queried with the key
// entered for it.
import { listModels } from '../../lib/llm.js';
import { readLlm } from '../../lib/settings.js';
import { json } from '../../lib/store.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  let target = env;
  if (body?.llm) {
    const r = readLlm(body.llm);
    if (r.error) return json({ error: r.error }, 400);
    target = { ...env, LLM_FORMAT: r.llm.format, LLM_BASE_URL: r.llm.baseUrl, LLM_API_KEY: r.llm.apiKey };
  } else if (!(env.LLM_BASE_URL && env.LLM_API_KEY)) {
    return json({ error: '先填写接口地址和 API key' }, 400);
  }
  try {
    const r = await listModels(target);
    return json(r, r.ok ? 200 : 502);
  } catch (e) {
    return json({ ok: false, error: e.message.slice(0, 300) }, 502);
  }
}
