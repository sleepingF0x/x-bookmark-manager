// Connection, sync and spend overview for the site's sidebar. The X balance is cached for an hour.
import { caps, getMeta, putMeta, usage } from '../../lib/store.js';
import { credits } from '../../lib/x.js';
import { llmConfigured } from '../../lib/llm.js';
import { authMode } from '../../auth.js';

export async function onRequestGet({ env }) {
  const [user, token, lastSync, u, pending] = await Promise.all([
    getMeta(env, 'x:user'), getMeta(env, 'x:token'), getMeta(env, 'x:lastSync'), usage(env),
    env.DB.prepare('SELECT count(*) AS n FROM items WHERE pending = 1').first(),
  ]);
  let balance = await getMeta(env, 'x:credits');
  if (user && token && (!balance || Date.now() - balance.at > 3600000)) {
    const c = await credits(env);
    if (c) { balance = { ...c, at: Date.now() }; await putMeta(env, 'x:credits', balance); }
  }
  return Response.json({
    configured: { x: Boolean(env.X_CLIENT_ID && env.X_CLIENT_SECRET), llm: llmConfigured(env) },
    connected: Boolean(user && token), user, lastSync, usage: u, caps: caps(env), balance, pending: pending.n,
    auth: authMode(env), // lets the page offer "退出登录" when Cloudflare Access handles sign-in
  });
}
