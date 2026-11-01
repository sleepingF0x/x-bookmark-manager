// X redirects here after the user approves; trade the code for tokens and remember who connected.
import { getMeta, putMeta } from '../../../lib/store.js';
import { exchangeCode, me, redirectUri } from '../../../lib/x.js';

const back = (request, msg) => Response.redirect(new URL('/#x=' + encodeURIComponent(msg), request.url).href, 302);

export async function onRequestGet({ request, env }) {
  const p = new URL(request.url).searchParams;
  const pending = await getMeta(env, 'x:oauth');
  await env.DB.prepare("DELETE FROM meta WHERE key = 'x:oauth'").run();
  if (p.get('error')) return back(request, '已取消授权');
  if (!pending || p.get('state') !== pending.state || Date.now() - pending.at > 10 * 60000) return back(request, '授权已过期，请重新连接');
  try {
    await exchangeCode(env, p.get('code'), pending.verifier, redirectUri(request));
    await putMeta(env, 'x:user', await me(env));
    return back(request, 'connected');
  } catch (e) {
    return back(request, '连接失败：' + e.message.slice(0, 120));
  }
}
