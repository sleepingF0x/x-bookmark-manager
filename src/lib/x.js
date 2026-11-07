// X API v2 client: OAuth 2.0 (authorization code + PKCE, confidential client) and the few calls the
// site needs. Tokens live in D1 meta; client id/secret are Pages secrets X_CLIENT_ID / X_CLIENT_SECRET.
import { addUsage, getMeta, putMeta, reserve } from './store.js';

export const API = 'https://api.x.com';
export const SCOPES = 'tweet.read users.read bookmark.read bookmark.write offline.access';

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const challenge = async (verifier) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
export const redirectUri = (request) => new URL('/api/x/callback', request.url).href;

export class XError extends Error {
  constructor(status, body) {
    super(`X API ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
  }
}

async function tokenRequest(env, params) {
  const r = await fetch(`${API}/2/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`),
    },
    body: new URLSearchParams({ client_id: env.X_CLIENT_ID, ...params }),
  });
  const body = await r.text();
  if (!r.ok) throw new XError(r.status, body);
  const t = JSON.parse(body);
  const token = { access: t.access_token, refresh: t.refresh_token, exp: Date.now() + t.expires_in * 1000, scope: t.scope };
  await putMeta(env, 'x:token', token);
  return token;
}

export const exchangeCode = (env, code, verifier, redirect) =>
  tokenRequest(env, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect });

async function accessToken(env) {
  const t = await getMeta(env, 'x:token');
  if (!t) throw new XError(401, '尚未连接 X');
  if (Date.now() < t.exp - 60000) return t.access;
  // X rotates the refresh token on use, so the new pair is saved before anything else happens.
  return (await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: t.refresh })).access;
}

export async function xFetch(env, path, init = {}) {
  const r = await fetch(API + path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await accessToken(env)}` } });
  const body = await r.text();
  if (!r.ok) throw new XError(r.status, body);
  return body ? JSON.parse(body) : {};
}

export async function me(env) {
  const { data } = await xFetch(env, '/2/users/me');
  return { id: data.id, username: data.username, name: data.name };
}

// Prepaid balance in USD; used to show what a sync actually cost. Failures are non-fatal.
export async function credits(env) {
  try { return (await xFetch(env, '/2/usage/credits')).data ?? null; } catch { return null; }
}

// The OpenAPI spec names these post.* while older deployments of the API used tweet.*; whichever
// the live API accepts is remembered so later syncs send one request per page.
const FIELDS = {
  post: {
    'post.fields': 'created_at,lang,entities,attachments,referenced_posts,note_post,article,author_id,conversation_id',
    expansions: 'author_id,attachments.media_keys,referenced_posts',
  },
  tweet: {
    'tweet.fields': 'created_at,lang,entities,attachments,referenced_tweets,note_tweet,article,author_id,conversation_id',
    expansions: 'author_id,attachments.media_keys,referenced_tweets.id',
  },
};
const COMMON = { 'user.fields': 'username,name', 'media.fields': 'type,url,preview_image_url,variants' };

// GET with the full field set, retrying once with the other naming if X rejects the parameters.
// Every returned post and expanded object is counted against the monthly read cap (a conservative
// superset of what X bills).
async function readWithFields(env, path, params, reserveN) {
  await reserve(env, 'reads', reserveN);
  let flavor = (await getMeta(env, 'x:fields')) || 'post';
  for (let attempt = 0; ; attempt++) {
    const q = new URLSearchParams({ ...params, ...FIELDS[flavor], ...COMMON });
    try {
      const page = await xFetch(env, `${path}?${q}`);
      const inc = page.includes || {};
      await addUsage(env, 'reads', (page.data?.length || 0) + (inc.posts || inc.tweets || []).length + (inc.users || []).length);
      await putMeta(env, 'x:fields', flavor);
      return page;
    } catch (e) {
      if (!(e instanceof XError) || e.status !== 400 || attempt) throw e;
      flavor = flavor === 'post' ? 'tweet' : 'post';
    }
  }
}

// One page of the user's bookmarks, newest first, with everything needed to build a library item.
export function bookmarksPage(env, userId, maxResults, paginationToken) {
  const params = { max_results: String(maxResults) };
  if (paginationToken) params.pagination_token = paginationToken;
  return readWithFields(env, `/2/users/${userId}/bookmarks`, params, maxResults * 3);
}

// Ids only (no fields, no expansions): the cheapest way to walk the whole list for reconciliation.
export async function bookmarkIdsPage(env, userId, paginationToken) {
  await reserve(env, 'reads', 100);
  const q = new URLSearchParams({ max_results: '100' });
  if (paginationToken) q.set('pagination_token', paginationToken);
  const page = await xFetch(env, `/2/users/${userId}/bookmarks?${q}`);
  await addUsage(env, 'reads', page.data?.length || 0);
  return page;
}

// Full details for specific posts (up to 100), shaped like a bookmarks page.
export const lookupPosts = (env, ids) => readWithFields(env, '/2/tweets', { ids: ids.join(',') }, ids.length * 3);

// Which of these posts (up to 100) still exist and are visible to the user. Ids only, no expansions:
// X bills per post returned, so a deleted post costs nothing. Ids in neither set were not answered for.
export async function visiblePosts(env, ids) {
  await reserve(env, 'reads', ids.length);
  const page = await xFetch(env, `/2/tweets?${new URLSearchParams({ ids: ids.join(',') })}`);
  await addUsage(env, 'reads', page.data?.length || 0);
  return {
    visible: new Set((page.data || []).map((p) => p.id)),
    missing: new Set((page.errors || []).map((e) => String(e.resource_id || e.value || '')).filter(Boolean)), // deleted, protected, suspended
  };
}

export async function removeBookmark(env, userId, tweetId) {
  await reserve(env, 'writes', 1);
  await addUsage(env, 'writes', 1); // billed per request, so count before knowing the outcome
  const r = await xFetch(env, `/2/users/${userId}/bookmarks/${tweetId}`, { method: 'DELETE' });
  return r.data?.bookmarked === false;
}

// Restoring from the recycle bin puts the post back into the X bookmark list (same $0.005 write).
export async function addBookmark(env, userId, tweetId) {
  await reserve(env, 'writes', 1);
  await addUsage(env, 'writes', 1);
  const r = await xFetch(env, `/2/users/${userId}/bookmarks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tweet_id: tweetId }),
  });
  return r.data?.bookmarked === true;
}
