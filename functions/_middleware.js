// Cloudflare Pages middleware: HTTP Basic auth in front of every page and asset.
// The password lives in the SITE_PASSWORD secret (any username is accepted).
const encoder = new TextEncoder();

async function sameSecret(a, b) {
  // Compare digests so timing does not leak how many leading characters matched.
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}

export async function onRequest({ request, env, next }) {
  const header = request.headers.get('Authorization') || '';
  if (env.SITE_PASSWORD && header.startsWith('Basic ')) {
    const decoded = atob(header.slice(6));
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (await sameSecret(password, env.SITE_PASSWORD)) {
      const res = await next();
      const out = new Response(res.body, res);
      out.headers.set('X-Robots-Tag', 'noindex, nofollow');
      out.headers.set('Cache-Control', 'private, no-store');
      return out;
    }
  }
  return new Response('需要密码', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="x-bookmarks", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
