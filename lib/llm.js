// Labelling with the user's own LLM endpoint (OpenAI- or Anthropic-compatible), configured by secrets:
//   LLM_BASE_URL  e.g. https://api.openai.com/v1 or https://api.anthropic.com
//   LLM_API_KEY, LLM_MODEL, optional LLM_FORMAT = openai | anthropic (guessed from the URL otherwise)
// Same instructions as scripts/classify.py so synced items are labelled like the seeded ones.

export const CATEGORIES = [
  'AI 编程与 Agent', 'AI 创作与应用', '开发与开源工具', '加密与 Web3', '投资理财与出入金',
  '网络与服务器', '副业、创业与个人品牌', '职场与求职', '数码与效率技巧', '健康与生活',
  '学习与阅读', '娱乐与杂项',
];
export const TYPES = ['工具/项目', '教程/方法', '资源合集', '观点/经验', '资讯'];

export const llmConfigured = (env) => Boolean(env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL);
const format = (env) => env.LLM_FORMAT || (/anthropic/i.test(env.LLM_BASE_URL) ? 'anthropic' : 'openai');

export async function chat(env, system, user, maxTokens = 4096) {
  const base = env.LLM_BASE_URL.replace(/\/+$/, '');
  if (format(env) === 'anthropic') {
    const r = await fetch(`${base}${/\/v1$/.test(base) ? '' : '/v1'}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.LLM_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: env.LLM_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()).content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
    body: JSON.stringify({ model: env.LLM_MODEL, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).choices[0].message.content;
}

const CLEANUP_RULES = `- cleanup：
  - junk：没有可检索的知识价值——纯娱乐/搞笑/颜值视频、情绪感慨、广告推销、无实质内容的标题党。
  - expired：内容价值依赖时效且已过期——已结束的空投/积分/撸毛交互/抢购/促销/NFT 铸造/活动；一次性新闻快讯；明确被新版本取代的工具或模型用法；内容以过时信息为核心的文章。
  - keep：其余。拿不准时选 keep。发布不满 30 天的资讯/活动还在时效内，不算 expired。
  “娱乐与杂项”也要逐条判断：有具体可用信息（如旅行攻略、实用冷知识）的仍是 keep。`;

function system(knownTags) {
  const today = new Date().toISOString().slice(0, 10);
  return `你在帮用户整理 X（推特）收藏，建个人知识库。今天是 ${today}。
每条收藏给出：作者、发布日期、正文，以及补全内容（[引用] 被引用推文、[文章] X 长文章全文、[link] 外链、[视频] 含视频但无转写）。

对每条输出：
- category：从这 12 类中选最贴切的一个：${CATEGORIES.join('、')}。
- tags：2-5 个中文或通用英文关键词，用于检索；优先用具体名词（产品名、技术名、币种、平台），不要用“AI”“分享”这类泛词。已有标签里有同一事物时沿用已有写法。
- type：${TYPES.join('、')} 之一。
- title：不超过 25 字的中文标题，概括这条讲什么（不是照抄第一句）。
- summary：1-2 句中文，说清楚“具体是什么 + 对读者有什么用”，不超过 80 字。
- score：作为知识库的长期价值，1-5 的整数。5=高质量深度内容或常用利器；3=有参考价值；1=几乎无信息。
${CLEANUP_RULES}
- cleanup_reason：cleanup 不是 keep 时用一句话说明理由，否则为空字符串。

已有标签（节选）：${knownTags.join('、')}

只输出一个 JSON 对象，不要任何其他文字：
{"items":[{"id":"…","category":"…","tags":["…"],"type":"…","title":"…","summary":"…","score":3,"cleanup":"keep","cleanup_reason":""}]}
必须覆盖输入里的每一个 id，原样返回 id。`;
}

// Returns {id: label fields in site format}; ids the model skipped or mangled are simply absent.
export async function classify(env, rows, knownTags) {
  const prompt = rows.map((r) => `<item id="${r.id}">\n${r.src}\n</item>`).join('\n\n');
  const out = await chat(env, system(knownTags), prompt);
  // Tweet ids exceed 2^53: if the model writes them as bare numbers, quote them before parsing.
  const parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1).replace(/"id"\s*:\s*(\d+)/g, '"id":"$1"'));
  // Models drift on spacing/punctuation in enum values ("加密与Web3"); match on a loose key.
  const loose = (v) => String(v || '').replace(/[\s、，,/]/g, '').toLowerCase();
  // A shortened name ("副业" for "副业、创业与个人品牌") is accepted when it fits exactly one entry.
  const pick = (list, v) => {
    const k = loose(v);
    const partial = k.length >= 2 ? list.filter((x) => loose(x).includes(k)) : [];
    return list.find((x) => loose(x) === k) || (partial.length === 1 ? partial[0] : undefined);
  };
  const canon = new Map(knownTags.map((t) => [t.toLowerCase().replace(/[\s-]/g, ''), t]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const labels = {};
  for (const it of parsed.items || []) {
    const row = byId.get(String(it.id));
    const category = pick(CATEGORIES, it.category), type = pick(TYPES, it.type);
    if (!row || !category || !type) continue;
    let cleanup = ['keep', 'expired', 'junk'].includes(it.cleanup) ? it.cleanup : 'keep';
    let reason = cleanup === 'keep' ? '' : String(it.cleanup_reason || '');
    // The model sometimes ignores the 30-day rule; news this fresh is still current.
    if (cleanup === 'expired' && type === '资讯' && Date.now() - Date.parse(row.data.date) < 30 * 864e5) { cleanup = 'keep'; reason = ''; }
    const tags = [...new Set((it.tags || []).slice(0, 5).map((t) => canon.get(String(t).toLowerCase().replace(/[\s-]/g, '')) || String(t)))];
    labels[row.id] = {
      category, tags, type,
      title: String(it.title || row.data.title).slice(0, 40), summary: String(it.summary || '').slice(0, 160),
      score: Math.max(1, Math.min(5, Math.round(+it.score) || 3)), cleanup, reason,
    };
  }
  Object.defineProperty(labels, 'raw', { value: parsed.items || [] }); // for /api/x/llmcheck diagnostics
  return labels;
}

// Cleanup-only re-check of already labelled items against today's date. Returns {id: {cleanup, reason}}.
export async function analyzeCleanup(env, items) {
  const today = new Date().toISOString().slice(0, 10);
  const sys = `你在帮用户清理 X（推特）收藏组成的个人知识库。今天是 ${today}。
每条给出发布日期、分类、类型、标题、摘要和正文开头。只判断它现在是否还值得留在收藏里：
${CLEANUP_RULES}
  带图片或视频的帖子，关键信息（工具名、清单、步骤）常常就在图里：不要仅因正文没写出具体名称或内容就判为 junk。
- reason：cleanup 不是 keep 时用一句话说明理由，否则为空字符串。

只输出一个 JSON 对象，不要任何其他文字：
{"items":[{"id":"…","cleanup":"keep","reason":""}]}
必须覆盖输入里的每一个 id，原样返回 id。`;
  const visual = (d) => {
    const n = (d.media || []).length;
    return n ? ` · 含${n}个${d.video ? '图片/视频' : '图片'}` : '';
  };
  const prompt = items.map((d) => `<item id="${d.id}">\n发布 ${d.date} · ${d.category} · ${d.type}${visual(d)}\n${d.title}\n${d.summary}\n${[d.article?.title, d.body].filter(Boolean).join('\n').slice(0, 400)}\n</item>`).join('\n\n');
  const out = await chat(env, sys, prompt);
  const parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1).replace(/"id"\s*:\s*(\d+)/g, '"id":"$1"'));
  const byId = new Map(items.map((d) => [d.id, d]));
  const res = {};
  for (const it of parsed.items || []) {
    const d = byId.get(String(it.id));
    if (!d || !['keep', 'expired', 'junk'].includes(it.cleanup)) continue;
    let cleanup = it.cleanup;
    // Same 30-day rule as labelling: fresh news is still current.
    if (cleanup === 'expired' && d.type === '资讯' && Date.now() - Date.parse(d.date) < 30 * 864e5) cleanup = 'keep';
    res[d.id] = { cleanup, reason: cleanup === 'keep' ? '' : String(it.reason || '').slice(0, 120) };
  }
  return res;
}
