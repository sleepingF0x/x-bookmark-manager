// D1 helpers shared by the API functions: the meta key/value table and monthly X API usage counters.

export async function getMeta(env, key) {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return row ? JSON.parse(row.value) : null;
}

export function putMeta(env, key, value) {
  return env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value)).run();
}

// A lease instead of a plain flag so a crashed request cannot hold the lock forever.
export async function acquireLock(env, name, ttlMs = 120000) {
  const now = Date.now();
  const r = await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2
     WHERE CAST(meta.value AS INTEGER) < ?3`).bind('lock:' + name, String(now + ttlMs), now).run();
  return r.meta.changes > 0;
}

export function releaseLock(env, name) {
  return env.DB.prepare('DELETE FROM meta WHERE key = ?').bind('lock:' + name).run();
}

// ---------- monthly API budget ----------
// X bills per resource returned (reads) and per request (bookmark writes). The caps are a hard stop
// in code, independent of the spending limit set in the X developer console.
const month = () => new Date().toISOString().slice(0, 7);

export function caps(env) {
  return { reads: +(env.X_MONTHLY_READ_CAP || 1500), writes: +(env.X_MONTHLY_WRITE_CAP || 200) };
}

export async function usage(env) {
  const m = month();
  const { results } = await env.DB.prepare('SELECT key, value FROM meta WHERE key IN (?, ?)')
    .bind(`usage:${m}:reads`, `usage:${m}:writes`).all();
  const get = (k) => +(results.find((r) => r.key === `usage:${m}:${k}`)?.value ?? 0);
  return { month: m, reads: get('reads'), writes: get('writes') };
}

export function addUsage(env, kind, n) {
  if (!n) return;
  return env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + ?2`)
    .bind(`usage:${month()}:${kind}`, n).run();
}

export class BudgetError extends Error {}

export async function reserve(env, kind, n) {
  const u = await usage(env);
  const cap = caps(env)[kind];
  if (u[kind] + n > cap) throw new BudgetError(`本月 X API ${kind === 'reads' ? '读取' : '写入'}已到上限（${u[kind]}/${cap}）`);
}

export const json = (body, status = 200) => Response.json(body, { status });
