// Turning X API posts into library rows, then labelling (user's LLM) and embedding (Workers AI) them.
// Mirrors scripts/digest.py + scripts/build_site.py so synced items look like the seeded ones.
import { classify, llmConfigured } from './llm.js';

const EMBED_MODEL = '@cf/baai/bge-m3'; // must match scripts/embed.py and src/api/embed.js

const refs = (p) => p.referenced_posts || p.referenced_tweets || [];

// X Article bodies have no documented shape in the API; collect the longer strings inside the object
// as paragraphs. (Seeded items carry the full structured article captured from the web app.)
function articleOf(p) {
  if (!p.article) return null;
  const out = [];
  const walk = (o) => {
    if (typeof o === 'string') { if (o.length > 20) out.push(o); }
    else if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') Object.values(o).forEach(walk);
  };
  walk(p.article);
  const title = p.article.title || p.article_title || '';
  const paras = [...new Set(out)].filter((x) => x !== title).join('\n').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  return { title, cover: null, blocks: paras.map((x) => ({ t: 'p', x })) };
}

// Post text with t.co links expanded and attached-media links dropped (media renders separately).
function bodyOf(p) {
  const note = p.note_post || p.note_tweet;
  let text = note?.text || p.text || '';
  for (const u of (note?.entities || p.entities)?.urls || []) {
    if (!u.url) continue;
    text = text.split(u.url).join(u.media_key || /\/(photo|video)\/\d+$/.test(u.expanded_url || '') ? '' : (u.expanded_url || u.url));
  }
  return text.trim();
}

function mediaOf(p, media) {
  return (p.attachments?.media_keys || []).map((k) => media.get(k)).filter(Boolean).map((m) => {
    if (m.type === 'photo') return { t: 'photo', u: m.url };
    const mp4 = (m.variants || []).filter((v) => v.content_type === 'video/mp4').sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
    return { t: m.type === 'animated_gif' ? 'gif' : 'video', u: m.preview_image_url, ...(mp4 ? { v: mp4.url } : {}) };
  });
}

function linkCards(p) {
  const urls = ((p.note_post || p.note_tweet)?.entities || p.entities)?.urls || [];
  const out = [...new Set(urls.filter((u) => !u.media_key).map((u) => u.expanded_url).filter(Boolean))];
  return { repos: [], links: out.filter((u) => !/^https?:\/\/(www\.)?(x|twitter)\.com\//.test(u)) };
}

// Classification input, same labels as scripts/digest.py.
function digestText(d) {
  const parts = [d.body];
  if (d.quote) parts.push(`[引用] @${d.quote.handle}: ${d.quote.body}`);
  if (d.article) parts.push('[文章] ' + [d.article.title, ...d.article.blocks.map((b) => b.x)].join('\n'));
  for (const l of d.links) parts.push('[link] ' + l);
  if (d.video) parts.push('[视频]');
  return parts.filter(Boolean).join('\n');
}

// Build pending rows (no labels yet) from one bookmarks page.
export function pageToRows(page) {
  const inc = page.includes || {};
  const users = new Map((inc.users || []).map((u) => [u.id, u]));
  const posts = new Map((inc.posts || inc.tweets || []).map((p) => [p.id, p]));
  const media = new Map((inc.media || []).map((m) => [m.media_key, m]));
  return (page.data || []).map((p) => {
    const u = users.get(p.author_id) || {};
    const handle = u.username || p.username || 'i';
    const ms = mediaOf(p, media);
    const quotedRef = refs(p).find((r) => r.type === 'quoted');
    const q = quotedRef && posts.get(quotedRef.id);
    const qu = q ? users.get(q.author_id) || {} : null;
    const quote = q ? { id: q.id, url: `https://x.com/${qu.username || 'i'}/status/${q.id}`, handle: qu.username || '?', name: qu.name || qu.username || '?',
      body: bodyOf(q), media: mediaOf(q, media), articleTitle: q.article?.title || null } : null;
    const body = bodyOf(p);
    const article = articleOf(p);
    const data = {
      id: p.id,
      url: `https://x.com/${handle}/status/${p.id}`,
      handle,
      name: u.name || handle,
      date: (p.created_at || '').slice(0, 10),
      category: '未分类',
      tags: [],
      type: '资讯',
      title: (article?.title || body.replace(/https?:\/\/\S+/g, '')).replace(/\s+/g, ' ').trim().slice(0, 25) || '（无正文）', // placeholder until labelled
      summary: '',
      score: 3,
      cleanup: 'keep',
      reason: '',
      thumb: ms[0]?.u || null,
      video: ms.some((m) => m.t !== 'photo'),
      body,
      media: ms,
      quote,
      article,
      thread: [],
      ...linkCards(p),
    };
    return { id: p.id, data, src: `@${handle} ${data.date}\n${digestText(data)}`.slice(0, 1500) };
  });
}

function toBase64(int8) {
  let s = '';
  for (let i = 0; i < int8.length; i++) s += String.fromCharCode(int8[i] & 0xff);
  return btoa(s);
}

// int8 quantization of the L2-normalised vector, same as scripts/embed.py.
async function embed(env, docs) {
  const { data } = await env.AI.run(EMBED_MODEL, { text: docs });
  return data.map((v) => {
    const n = Math.hypot(...v) || 1;
    return toBase64(Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round((x / n) * 127)))));
  });
}

const embedDoc = (d) => `${d.title}\n${d.summary}\n${d.tags.join(' ')} ${d.category}\n${(d.body || '').slice(0, 400)}`;

// Label and embed up to `limit` pending rows. Without an LLM configured, items are embedded with
// their raw text and stay pending so they get labelled once the LLM secrets exist.
export async function processPending(env, limit = 20) {
  const llm = llmConfigured(env);
  const { results } = await env.DB.prepare(
    `SELECT id, data, src FROM items WHERE pending = 1 ${llm ? '' : 'AND vec IS NULL'} ORDER BY no DESC LIMIT ?`).bind(limit).all();
  if (!results.length) return { processed: 0, labelled: 0 };
  const rows = results.map((r) => ({ id: r.id, data: JSON.parse(r.data), src: r.src }));
  let labels = {};
  if (llm) {
    const known = await env.DB.prepare(
      `SELECT j.value AS tag, count(*) AS n FROM items, json_each(json_extract(items.data, '$.tags')) AS j
       GROUP BY lower(j.value) ORDER BY n DESC LIMIT 120`).all();
    labels = await classify(env, rows, known.results.map((r) => r.tag));
  }
  const vecs = await embed(env, rows.map((r) => embedDoc({ ...r.data, ...labels[r.id] })));
  const stmts = rows.map((r, i) => {
    const lab = labels[r.id];
    const data = lab ? { ...r.data, ...lab } : r.data;
    return env.DB.prepare('UPDATE items SET data = ?, vec = ?, pending = ?, src = ? WHERE id = ?')
      .bind(JSON.stringify(data), vecs[i], lab ? 0 : 1, lab ? null : r.src, r.id);
  });
  await env.DB.batch(stmts);
  return { processed: rows.length, labelled: Object.keys(labels).length };
}
