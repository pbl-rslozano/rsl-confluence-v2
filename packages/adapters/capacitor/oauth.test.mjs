import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppLinkOAuth } from './oauth.js';
import { makeNativeRequest } from './native-request.js';

const OK = (u) => u.startsWith('https://accounts.google.com/');
const REDIR = 'https://example.invalid/app/cb';
const mk = () => {
  const log = []; let handler = null;
  return {
    log, fire: (url) => handler?.({ url }),
    addListener: async (ev, h) => { log.push('listen:' + ev); handler = h; return { remove: async () => { log.push('remove'); handler = null; } }; },
    open: async () => { log.push('open'); },
  };
};
const O = (extra = {}) => ({ redirectUri: REDIR, relayFragment: false, timeoutMs: 1000, ...extra });

test('app link resolves on the matching URL and cleans up', async () => {
  const f = mk();
  const oauth = createAppLinkOAuth({ addListener: f.addListener, open: f.open, isSignIn: OK });
  assert.equal(oauth.kind, 'applink');
  const p = oauth.authorize('https://accounts.google.com/x', O());
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(f.log.slice(0, 2), ['listen:appUrlOpen', 'open']);
  f.fire('https://other.invalid/zzz');
  f.fire(REDIR + '?code=a&state=b');
  assert.equal(await p, REDIR + '?code=a&state=b');
  assert.ok(f.log.includes('remove'));
});

test('timeout rejects and removes the listener', async () => {
  const f = mk();
  const oauth = createAppLinkOAuth({ addListener: f.addListener, open: f.open, isSignIn: OK });
  await assert.rejects(oauth.authorize('https://accounts.google.com/x', O({ timeoutMs: 30 })), (e) => e.message === 'timeout');
  assert.ok(f.log.includes('remove'));
});

test('abort rejects cancelled and removes the listener; non-sign-in refused first', async () => {
  const f = mk();
  const ac = new AbortController();
  const oauth = createAppLinkOAuth({ addListener: f.addListener, open: f.open, isSignIn: OK });
  const p = oauth.authorize('https://accounts.google.com/x', O({ signal: ac.signal }));
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  await assert.rejects(p, (e) => e.message === 'cancelled');
  assert.ok(f.log.includes('remove'));
  const g = mk();
  const o2 = createAppLinkOAuth({ addListener: g.addListener, open: g.open, isSignIn: OK });
  await assert.rejects(o2.authorize('https://evil.example/', O()));
  assert.deepEqual(g.log, []);
});

test('capacitor native request: allowlist fence, disableRedirects, size cap', async () => {
  const seen = [];
  const ok = (u) => u.startsWith('https://graph.microsoft.com/');
  const req = async (o) => { seen.push(o); return { status: 200, headers: { 'Content-Type': 'text/plain' }, data: 'hi' }; };
  const r = await makeNativeRequest(ok, req)({ method: 'PUT', url: 'https://graph.microsoft.com/a', headers: { A: 'b' }, body: 'x' });
  assert.deepEqual(r, { status: 200, headers: { 'content-type': 'text/plain' }, text: 'hi' });
  assert.deepEqual(seen[0], { url: 'https://graph.microsoft.com/a', method: 'PUT', headers: { A: 'b' }, data: 'x', responseType: 'text', connectTimeout: 15000, readTimeout: 60000, disableRedirects: true });
  await assert.rejects(makeNativeRequest(ok, req)({ method: 'GET', url: 'https://evil.example/' }), /Native request refused/);
  assert.equal(seen.length, 1);
  const big = async () => ({ status: 200, headers: {}, data: 'x'.repeat(20 * 1024 * 1024 + 1) });
  await assert.rejects(makeNativeRequest(ok, big)({ method: 'GET', url: 'https://graph.microsoft.com/a' }), /too-large-file/);
});
