// Settings edited on the site's settings panel, stored in D1 meta under 'settings'. They take precedence
// over the deployment's environment variables, which stay as a fallback so deployments configured
// before the panel existed keep working:
//   readCap / writeCap   X_MONTHLY_READ_CAP / X_MONTHLY_WRITE_CAP   monthly X API caps
//   model                LLM_MODEL
//   llm {format, baseUrl, apiKey}   LLM_FORMAT / LLM_BASE_URL / LLM_API_KEY
// The endpoint and its key are one unit, always saved together: a stored key is never sent to an
// address it was not entered for. Sign-in (SITE_PASSWORD, ACCESS_*) and the X app credentials are not
// settings: the first protects this very panel, the second is entered once at deploy time.
import { DEFAULT_CAPS, getMeta, putMeta } from './store.js';

const KEY = 'settings';

export async function loadSettings(env) {
  return (await getMeta(env, KEY)) || {};
}

export const saveSettings = (env, s) => putMeta(env, KEY, s);

// The env the app runs with: the deployment's environment with the saved settings laid over it.
export function applySettings(env, s) {
  const out = { ...env };
  if (s.readCap) out.X_MONTHLY_READ_CAP = String(s.readCap);
  if (s.writeCap) out.X_MONTHLY_WRITE_CAP = String(s.writeCap);
  if (s.llm) Object.assign(out, { LLM_FORMAT: s.llm.format, LLM_BASE_URL: s.llm.baseUrl, LLM_API_KEY: s.llm.apiKey });
  if (s.model) out.LLM_MODEL = s.model;
  return out;
}

// https only, except a model server on this machine (Ollama, LM Studio…) for the Docker edition.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);
export function normalBaseUrl(value) {
  let u;
  try { u = new URL(String(value || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return u.href.replace(/\/+$/, '');
}

// Validates one LLM endpoint as sent by the panel. Returns {llm} or {error}.
export function readLlm(v) {
  if (!v || typeof v !== 'object') return { error: '模型接口格式不对' };
  const format = v.format === 'anthropic' ? 'anthropic' : v.format === 'openai' ? 'openai' : null;
  if (!format) return { error: '接口格式只能是 openai 或 anthropic' };
  const baseUrl = normalBaseUrl(v.baseUrl);
  if (!baseUrl) return { error: '接口地址需要是 https:// 开头的完整地址（本机的模型服务可以用 http://localhost）' };
  const apiKey = typeof v.apiKey === 'string' ? v.apiKey.trim() : '';
  if (!apiKey) return { error: '保存或更换模型接口时需要填写 API key' };
  if (apiKey.length > 1000 || /\s/.test(apiKey)) return { error: 'API key 格式不对' };
  return { llm: { format, baseUrl, apiKey } };
}

export function readCap(v) {
  if (v === null || v === '') return { value: null };
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 1e6 ? { value: n } : { error: '上限需要是 1 到 1000000 之间的整数' };
}

export function readModel(v) {
  if (v === null || v === '') return { value: null };
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s.length <= 200 ? { value: s } : { error: '模型名格式不对' };
}

// What the panel shows. Never includes a key: at most its last four characters, for recognising it.
export function describe(env, s) {
  const eff = applySettings(env, s);
  const source = (page, fromEnv) => (page ? 'page' : fromEnv ? 'env' : 'default');
  const key = eff.LLM_API_KEY || '';
  const envLlm = Boolean(env.LLM_BASE_URL && env.LLM_API_KEY);
  const cap = (page, fromEnv, dflt) => ({
    page: page || null, source: source(page, fromEnv), fallback: +(fromEnv || dflt), fallbackFrom: fromEnv ? 'env' : 'default',
  });
  return {
    readCap: cap(s.readCap, env.X_MONTHLY_READ_CAP, DEFAULT_CAPS.reads),
    writeCap: cap(s.writeCap, env.X_MONTHLY_WRITE_CAP, DEFAULT_CAPS.writes),
    model: { page: s.model || null, fallback: env.LLM_MODEL || '', source: source(s.model, env.LLM_MODEL) },
    llm: {
      source: s.llm ? 'page' : envLlm ? 'env' : null,
      format: eff.LLM_FORMAT || (/anthropic/i.test(eff.LLM_BASE_URL || '') ? 'anthropic' : 'openai'),
      baseUrl: eff.LLM_BASE_URL || '',
      keyHint: key.length >= 16 ? key.slice(-4) : '',
      hasKey: Boolean(key),
      envAvailable: envLlm,
    },
  };
}
