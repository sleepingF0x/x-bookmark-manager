// HTTP Basic auth in front of every page, asset and API route.
// The password lives in SITE_PASSWORD (any username is accepted); without it every request is refused.
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

// Returns null when the request may proceed, otherwise the 401 response to send.
export async function checkAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (env.SITE_PASSWORD && header.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = atob(header.slice(6)); } catch {}
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (await sameSecret(password, env.SITE_PASSWORD)) return null;
  }
  return new Response('需要密码', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="x-bookmarks", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
