// Sign-in in front of every page, asset and API route. Two modes, chosen by configuration:
//
// - Cloudflare Access (ACCESS_TEAM_DOMAIN + ACCESS_AUD set): Access shows its own login page at the
//   edge; here we verify the signed JWT it adds as Cf-Access-Jwt-Assertion, so a request that reaches
//   the app some other way is still refused. (Workers with Static Assets do not get ctx.access, which
//   is why the token is checked by hand.) Works for the Docker edition too when it sits behind Access.
// - Password (otherwise): HTTP Basic auth against SITE_PASSWORD, any username. Without it every
//   request is refused.
const encoder = new TextEncoder();

// Compare digests in constant time so timing does not leak how many leading characters matched.
// (Written by hand: crypto.subtle.timingSafeEqual exists on Workers but not in Node.)
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

const text = (body, status, headers = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });

// "myteam", "myteam.cloudflareaccess.com" and "https://myteam.cloudflareaccess.com/" all name the
// same issuer. Always https: Access never issues tokens from a plain-http origin.
export function teamOrigin(value) {
  const host = String(value).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  return host ? `https://${host.includes('.') ? host : `${host}.cloudflareaccess.com`}` : '';
}

export function authMode(env) {
  if (env.ACCESS_TEAM_DOMAIN || env.ACCESS_AUD) return 'access';
  return 'password';
}

// ---------- Cloudflare Access JWT (RS256) ----------
const KEY_TTL = 60 * 60000;     // re-read the signing keys hourly; Access rotates them every few weeks
const MISS_RETRY = 60000;       // an unknown kid triggers at most one extra fetch per minute
let keyCache = { origin: '', at: 0, keys: new Map() };

async function loadKeys(origin) {
  const r = await fetch(`${origin}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`certs ${r.status}`);
  const keys = new Map();
  for (const jwk of (await r.json()).keys || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    keys.set(jwk.kid, await crypto.subtle.importKey(
      'jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  keyCache = { origin, at: Date.now(), keys };
}

class KeyFetchError extends Error {}

async function signingKey(origin, kid) {
  const cached = keyCache.origin === origin ? keyCache.keys.get(kid) : undefined;
  const age = keyCache.origin === origin ? Date.now() - keyCache.at : Infinity;
  if (age > KEY_TTL || (!cached && age > MISS_RETRY)) {
    try { await loadKeys(origin); } catch (e) {
      if (cached) return cached; // keep serving with the last good key while the certs URL is down
      throw new KeyFetchError(e.message);
    }
  }
  return keyCache.origin === origin ? keyCache.keys.get(kid) : undefined;
}

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

// Returns the token's claims when it is a valid Access token for this application, otherwise throws.
export async function verifyAccessJwt(token, env, now = Date.now()) {
  const origin = teamOrigin(env.ACCESS_TEAM_DOMAIN);
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = json(parts[0]);
  if (header.alg !== 'RS256') throw new Error('unexpected alg');
  const key = await signingKey(origin, header.kid);
  if (!key) throw new Error('unknown signing key');
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('bad signature');
  const claims = json(parts[1]);
  const t = now / 1000, skew = 60;
  if (claims.iss !== origin) throw new Error('wrong issuer');
  if (![].concat(claims.aud).includes(env.ACCESS_AUD)) throw new Error('wrong audience');
  if (!(claims.exp > t - skew)) throw new Error('expired');
  if (claims.nbf && claims.nbf > t + skew) throw new Error('not yet valid');
  return claims;
}

async function checkAccess(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    // Half-configured: refuse rather than silently fall back to the password.
    return text('Cloudflare Access 配置不完整：ACCESS_TEAM_DOMAIN 和 ACCESS_AUD 需要同时设置', 500);
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return text('需要通过 Cloudflare Access 登录', 403);
  try {
    await verifyAccessJwt(token, env);
    return null;
  } catch (e) {
    if (e instanceof KeyFetchError) return text('暂时无法读取 Cloudflare Access 公钥，请稍后重试', 503);
    return text('Cloudflare Access 登录无效：' + e.message, 403);
  }
}

// ---------- password (HTTP Basic) ----------
async function checkPassword(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (env.SITE_PASSWORD && header.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = atob(header.slice(6)); } catch {}
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (await sameSecret(password, env.SITE_PASSWORD)) return null;
  }
  return text('需要密码', 401, { 'WWW-Authenticate': 'Basic realm="x-bookmarks", charset="UTF-8"' });
}

// Returns null when the request may proceed, otherwise the response to send.
export function checkAuth(request, env) {
  return authMode(env) === 'access' ? checkAccess(request, env) : checkPassword(request, env);
}
