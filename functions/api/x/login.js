// Start the X OAuth 2.0 authorization (PKCE). The verifier stays server-side in D1.
import { putMeta } from '../../../lib/store.js';
import { SCOPES, challenge, randomToken, redirectUri } from '../../../lib/x.js';

export async function onRequestGet({ request, env }) {
  if (!env.X_CLIENT_ID || !env.X_CLIENT_SECRET) {
    return new Response('还没有配置 X_CLIENT_ID / X_CLIENT_SECRET', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const state = randomToken();
  const verifier = randomToken();
  await putMeta(env, 'x:oauth', { state, verifier, at: Date.now() });
  const q = new URLSearchParams({
    response_type: 'code', client_id: env.X_CLIENT_ID, redirect_uri: redirectUri(request), scope: SCOPES,
    state, code_challenge: await challenge(verifier), code_challenge_method: 'S256',
  });
  return Response.redirect(`https://x.com/i/oauth2/authorize?${q}`, 302);
}
