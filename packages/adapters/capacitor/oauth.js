/**
 * WP28 Task 6: phone sign-in broker. The provider redirects to the app's verified link; `appUrlOpen` delivers it.
 * `addListener` (App.addListener) and `open` (window.open) are injected by index.js. The listener is registered
 * BEFORE the browser opens and removed on resolve, timeout and abort.
 */
export function createAppLinkOAuth({ addListener, open, isSignIn }) {
  return {
    kind: 'applink',
    async authorize(url, o) {
      if (typeof isSignIn !== 'function' || !isSignIn(url)) throw new Error('Sign-in refused: URL not on the sign-in allowlist');
      if (o.signal?.aborted) throw new Error('cancelled');
      let handle = null;
      let timer = null;
      let onAbort = null;
      const cleanup = async () => {
        if (timer) clearTimeout(timer);
        if (onAbort) o.signal?.removeEventListener('abort', onAbort);
        const h = handle; handle = null;
        if (h) { try { await h.remove(); } catch { /* already gone */ } }
      };
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, v) => { if (settled) return; settled = true; cleanup().then(() => fn(v)); };
        timer = setTimeout(() => finish(reject, new Error('timeout')), o.timeoutMs);
        onAbort = () => finish(reject, new Error('cancelled'));
        o.signal?.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(addListener('appUrlOpen', (ev) => {
          const u = ev && typeof ev.url === 'string' ? ev.url : '';
          if (u.startsWith(o.redirectUri)) finish(resolve, u);
        })).then(async (h) => {
          handle = h;
          if (settled) { await cleanup(); return; }
          await open(url, '_blank');
        }).catch(() => finish(reject, new Error('sign-in')));
      });
    },
  };
}
