/**
 * WP28 Task 6: desktop sign-in broker. A loopback listener in Rust (src-tauri/src/oauth_loopback.rs) catches the
 * redirect on 127.0.0.1:48787. `invoke` and `openUrl` are injected by index.js so this module imports no native
 * package. The listener is bound BEFORE the browser opens so the redirect can never arrive first.
 */
const ORIGIN = 'http://127.0.0.1:48787';
const msg = (e) => (typeof e === 'string' ? e : e instanceof Error ? e.message : '');

export function createLoopbackOAuth({ invoke, openUrl, isSignIn }) {
  return {
    kind: 'loopback',
    async authorize(url, o) {
      if (typeof isSignIn !== 'function' || !isSignIn(url)) throw new Error('Sign-in refused: URL not on the sign-in allowlist');
      if (o.signal?.aborted) throw new Error('cancelled');
      try { await invoke('oauth_loopback_bind'); } catch (e) { throw new Error(msg(e) === 'port-busy' ? 'port-busy' : 'bind-failed'); }
      let aborted = false;
      const onAbort = () => { aborted = true; invoke('oauth_loopback_cancel').catch(() => {}); };
      o.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (o.signal?.aborted) onAbort();
        await openUrl(url);
        const path = await invoke('oauth_loopback_wait', { timeoutMs: o.timeoutMs, relayFragment: Boolean(o.relayFragment) });
        if (aborted) throw new Error('cancelled');
        // The relay moved pCloud's fragment into the query for the server. Hand the web core exactly what the
        // provider sent: the fragment.
        if (o.relayFragment) return ORIGIN + '/callback#' + String(path).replace(/^\/callback\?/, '');
        return ORIGIN + path;
      } catch (e) {
        if (aborted) throw new Error('cancelled');
        invoke('oauth_loopback_cancel').catch(() => {}); // e.g. the browser failed to open: free the bound listener
        const m = msg(e);
        throw new Error(m === 'timeout' || m === 'cancelled' ? m : 'sign-in');
      } finally {
        o.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
