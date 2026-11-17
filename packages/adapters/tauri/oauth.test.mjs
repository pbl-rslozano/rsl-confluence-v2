import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoopbackOAuth } from './oauth.js';
import { makeNativeRequest } from './native-request.js';

const OK = (u) => u.startsWith('https://accounts.google.com/');
const O = { redirectUri: 'http://127.0.0.1:48787/callback', relayFragment: false, timeoutMs: 1000 };

test('binds before opening the browser', async () => {
  const calls = [];
  const invoke = async (cmd, args) => { calls.push(cmd); if (cmd === 'oauth_loopback_wait') { assert.deepEqual(args, { timeoutMs: 1000, relayFragment: false }); return '/callback?code=a&state=b'; } };
  const oauth = createLoopbackOAuth({ invoke, openUrl: async () => { calls.push('open'); }, isSignIn: OK });
  assert.equal(oauth.kind, 'loopback');
  const back = await oauth.authorize('https://accounts.google.com/o/oauth2/v2/auth?x=1', O);
  assert.deepEqual(calls, ['oauth_loopback_bind', 'open', 'oauth_loopback_wait']);
  assert.equal(back, 'http://127.0.0.1:48787/callback?code=a&state=b');
});

test('port-busy rejects without opening', async () => {
  let opened = false;
  const invoke = async (cmd) => { if (cmd === 'oauth_loopback_bind') throw 'port-busy'; };
  const oauth = createLoopbackOAuth({ invoke, openUrl: async () => { opened = true; }, isSignIn: OK });
  await assert.rejects(oauth.authorize('https://accounts.google.com/x', O), (e) => e.message === 'port-busy');
  assert.equal(opened, false);
});

test('a non-sign-in URL is refused before bind', async () => {
  const calls = [];
  const oauth = createLoopbackOAuth({ invoke: async (c) => { calls.push(c); }, openUrl: async () => { calls.push('open'); }, isSignIn: OK });
  await assert.rejects(oauth.authorize('https://evil.example/x', O));
  assert.deepEqual(calls, []);
});

test('abort cancels the listener and rejects cancelled', async () => {
  const calls = [];
  let release;
  const invoke = (cmd) => {
    calls.push(cmd);
    if (cmd === 'oauth_loopback_wait') return new Promise((_, rej) => { release = rej; });
    if (cmd === 'oauth_loopback_cancel') { release('cancelled'); }
    return Promise.resolve();
  };
  const ac = new AbortController();
  const oauth = createLoopbackOAuth({ invoke, openUrl: async () => {}, isSignIn: OK });
  const p = oauth.authorize('https://accounts.google.com/x', { ...O, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  await assert.rejects(p, (e) => e.message === 'cancelled');
  assert.ok(calls.includes('oauth_loopback_cancel'));
});

test('an already-aborted signal never binds', async () => {
  const calls = [];
  const ac = new AbortController(); ac.abort();
  const oauth = createLoopbackOAuth({ invoke: async (c) => { calls.push(c); }, openUrl: async () => {}, isSignIn: OK });
  await assert.rejects(oauth.authorize('https://accounts.google.com/x', { ...O, signal: ac.signal }), (e) => e.message === 'cancelled');
  assert.deepEqual(calls, []);
});

test('native request refuses unlisted URLs, sends no redirects, caps size', async () => {
  const seen = [];
  const mk = (res) => async (url, init) => { seen.push({ url, init }); return res; };
  const ok = (u) => u.startsWith('https://www.googleapis.com/');
  const good = { status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), text: async () => '{}' };
  const call = makeNativeRequest(ok, mk(good));
  const r = await call({ method: 'POST', url: 'https://www.googleapis.com/a', headers: { A: 'b' }, body: 'x' });
  assert.deepEqual(r, { status: 200, headers: { 'content-type': 'application/json' }, text: '{}' });
  assert.equal(seen[0].init.maxRedirections, 0);
  assert.equal(seen[0].init.connectTimeout, 15000);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.body, 'x');

  await assert.rejects(call({ method: 'GET', url: 'https://evil.example/' }), /Native request refused: URL not on the backup allowlist/);
  assert.equal(seen.length, 1);

  const big = { status: 200, headers: new Headers({ 'content-length': String(20 * 1024 * 1024 + 1) }), text: async () => assert.fail('body read') };
  await assert.rejects(makeNativeRequest(ok, mk(big))({ method: 'GET', url: 'https://www.googleapis.com/a' }), /too-large-file/);

  const bigText = { status: 200, headers: new Headers(), text: async () => 'x'.repeat(20 * 1024 * 1024 + 1) };
  await assert.rejects(makeNativeRequest(ok, mk(bigText))({ method: 'GET', url: 'https://www.googleapis.com/a' }), /too-large-file/);
});
