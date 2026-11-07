// Unit checks for src/auth.js: Cloudflare Access JWT verification and the password fallback.
// Node built-ins only; the Access certs endpoint is stubbed, so no network or credentials are needed.
import assert from 'node:assert/strict';
import { authMode, checkAuth, teamOrigin } from '../src/auth.js';

const TEAM = 'https://unit-test.cloudflareaccess.com';
const AUD = 'aud-tag-for-tests';
const env = { ACCESS_TEAM_DOMAIN: 'unit-test', ACCESS_AUD: AUD };

const alg = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const good = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
const rogue = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', good.publicKey)), kid: 'k1', alg: 'RS256' };

let certFetches = 0, certsDown = false;
globalThis.fetch = async (url) => {
  if (certsDown) throw new TypeError('fetch failed');
  assert.equal(String(url), `${TEAM}/cdn-cgi/access/certs`);
  certFetches++;
  return Response.json({ keys: [jwk] });
};

const b64 = (data) => Buffer.from(typeof data === 'string' ? data : new Uint8Array(data)).toString('base64url');
async function token(claims = {}, { key = good.privateKey, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', kid: 'k1', ...header }));
  const body = b64(JSON.stringify({ iss: TEAM, aud: [AUD], exp: now + 600, iat: now, email: 'me@example.com', ...claims }));
  return `${head}.${body}.${b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`)))}`;
}
const req = (headers = {}) => new Request('https://app.example/api/items', { headers });
async function expect(promise, status, pattern) {
  const res = await promise;
  if (status === null) return assert.equal(res, null);
  assert.equal(res?.status, status);
  if (pattern) assert.match(await res.text(), pattern);
}
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('team domain normalisation', () => {
  for (const v of ['unit-test', 'unit-test.cloudflareaccess.com', 'https://unit-test.cloudflareaccess.com/', ' HTTP://Unit-Test.cloudflareaccess.com ']) {
    assert.equal(teamOrigin(v), TEAM, v);
  }
});
test('mode selection', () => {
  assert.equal(authMode({ SITE_PASSWORD: 'x' }), 'password');
  assert.equal(authMode({ ...env, SITE_PASSWORD: 'x' }), 'access');
  assert.equal(authMode({ ACCESS_AUD: AUD }), 'access');
});
test('valid Access token passes', async () => {
  await expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': await token() }), env), null);
  await expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': await token({ aud: AUD }) }), env), null); // aud as a string
});
test('signing keys are cached', async () => {
  const before = certFetches;
  await expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': await token() }), env), null);
  assert.equal(certFetches, before);
});
test('missing token is refused', () => expect(checkAuth(req(), env), 403, /Cloudflare Access/));
test('password is not accepted in Access mode', async () => {
  const basic = 'Basic ' + Buffer.from('u:pw').toString('base64');
  await expect(checkAuth(req({ Authorization: basic }), { ...env, SITE_PASSWORD: 'pw' }), 403);
});
test('wrong audience', async () => expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': await token({ aud: ['other-app'] }) }), env), 403, /audience/));
test('wrong issuer', async () => expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': await token({ iss: 'https://evil.cloudflareaccess.com' }) }), env), 403, /issuer/));
test('expired', async () => expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': await token({ exp: Math.floor(Date.now() / 1000) - 120 }) }), env), 403, /expired/));
test('not yet valid', async () => expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': await token({ nbf: Math.floor(Date.now() / 1000) + 600 }) }), env), 403, /not yet/));
test('signed by another key', async () => expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': await token({}, { key: rogue.privateKey }) }), env), 403, /signature/));
test('tampered claims', async () => {
  const [h, , s] = (await token()).split('.');
  const forged = `${h}.${b64(JSON.stringify({ iss: TEAM, aud: [AUD], exp: 9e9 }))}.${s}`;
  await expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': forged }), env), 403, /signature/);
});
test('alg none / HS256 rejected', async () => {
  const head = b64(JSON.stringify({ alg: 'none', kid: 'k1' }));
  const body = b64(JSON.stringify({ iss: TEAM, aud: [AUD], exp: 9e9 }));
  await expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': `${head}.${body}.` }), env), 403, /alg/);
  await expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': await token({}, { header: { alg: 'HS256' } }) }), env), 403, /alg/);
});
test('garbage token', () => expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': 'not-a-jwt' }), env), 403));
test('unknown kid', async () => expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': await token({}, { header: { kid: 'k9' } }) }), env), 403, /signing key/));
test('half-configured Access fails closed', async () => {
  await expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': await token() }), { ACCESS_AUD: AUD, SITE_PASSWORD: 'pw' }), 500, /配置不完整/);
  await expect(checkAuth(req(), { ACCESS_TEAM_DOMAIN: 'unit-test' }), 500, /配置不完整/);
});
test('certs endpoint down with no cached key → 503', async () => {
  certsDown = true;
  try {
    await expect(checkAuth(req({ 'Cf-Access-Jwt-Assertion': await token() }), { ACCESS_TEAM_DOMAIN: 'other-team', ACCESS_AUD: AUD }), 503);
  } finally { certsDown = false; }
});
test('password mode unchanged', async () => {
  const basic = (pw) => ({ Authorization: 'Basic ' + Buffer.from('anyone:' + pw).toString('base64') });
  await expect(checkAuth(req(basic('pw')), { SITE_PASSWORD: 'pw' }), null);
  const denied = await checkAuth(req(basic('nope')), { SITE_PASSWORD: 'pw' });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /^Basic /);
  assert.equal((await checkAuth(req(basic('')), {})).status, 401); // no SITE_PASSWORD → always refused
});

let failed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.error('FAIL', name, '\n', e); }
}
if (failed) process.exitCode = 1;
